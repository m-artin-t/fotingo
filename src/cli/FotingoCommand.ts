import { Command } from '@oclif/command';
import { IConfig } from '@oclif/config';
import { boundMethod } from 'autobind-decorator';
import { Debugger } from 'debug';
import envCi from 'env-ci';
import { existsSync, mkdirSync } from 'fs';
import {
  always,
  concat,
  equals,
  ifElse,
  lensPath,
  mergeDeepRight,
  path,
  prop,
  set,
  zipObj,
} from 'ramda';
import { EMPTY, from, merge, Observable, ObservableInput, of, throwError, zip } from 'rxjs';
import { catchError, concatMap, last, map, reduce, switchMap, tap } from 'rxjs/operators';
import { readConfig, requiredConfigs, writeConfig } from 'src/config';
import { enhanceConfig, enhanceConfigWithRuntimeArguments } from 'src/enhanceConfig';
import { BranchInfo, Git } from 'src/git/Git';
import { GitErrorType } from 'src/git/GitError';
import { Github } from 'src/git/Github';
import { debug } from 'src/io/debug';
import { Emoji, Messenger } from 'src/io/messenger';
import { Jira } from 'src/issue-tracker/jira/Jira';
import { JiraError } from 'src/issue-tracker/jira/JiraError';
import { Tracker } from 'src/issue-tracker/Tracker';
import { Config, Issue, LocalChanges } from 'src/types';
import { renderUi } from 'src/ui/ui';

const returnIfFalse = (message: string) => ifElse(equals(true), always(undefined), () => message);

/**
 * Abstract class every fotingo command must extend. It provides
 * defaults and helper methods to make it easier to
 * create a command
 */
export abstract class FotingoCommand<T, R> extends Command {
  protected messenger: Messenger;
  protected fotingo: Config;
  protected tracker: Tracker;
  protected github: Github;
  protected git: Git;
  protected readonly isCi: boolean;
  protected readonly debug: Debugger;
  protected readonly validations: {
    defaultBranchExist: (commandData$: Observable<R>) => [() => Observable<boolean>, string];
    isGitRepo: (commandData$: Observable<R>) => [() => Observable<boolean>, string];
  };

  constructor(argv: string[], config: IConfig) {
    super(argv, config);
    this.createConfigFolder();
    this.isCi = envCi().isCi;
    this.debug = debug.extend(this.constructor.name.toLowerCase());
    this.messenger = new Messenger();
    this.validations = {
      defaultBranchExist: () => [
        () => from(this.git.doesBranchExist(this.fotingo.git.baseBranch)),
        `Couldn't find any branch that matched ${this.fotingo.git.baseBranch} to use as base branch`,
      ],
      isGitRepo: () => [this.isGitRepo, 'Fotingo needs to run inside a git repository'],
    };
    this.debug(`Running fotingo in CI: ${this.isCi}`);
  }

  /**
   * Initialize the fotingo configuration with the values
   * from the configuration file and the inferred configuration
   * from the environment
   */
  private async initializeFotingoConfig(): Promise<void> {
    this.fotingo = await this.readConfig();
    const enhancedConfig = await enhanceConfig(this.fotingo);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { flags } = this.parse(this.constructor as any);
    this.fotingo = await enhanceConfigWithRuntimeArguments(
      enhancedConfig,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      flags as { [k: string]: any },
    );
  }

  /**
   * Create the fotingo config folder if it doesn't exist
   */
  private createConfigFolder(): void {
    const path = `${this.config.home}/.fotingo_config`;
    if (!existsSync(path)) {
      mkdirSync(path);
    }
  }

  /**
   * Read the configuration and ask the user to provide anny missing configuration
   */
  private async readConfig(): Promise<Config> {
    const initialConfig = readConfig();
    let config: Config | undefined = undefined;
    const ui = renderUi({
      cmd: () =>
        this.askForRequiredConfig(initialConfig).pipe(
          map((d) => mergeDeepRight(initialConfig, d) as Config),
          tap(async (innerConfig: Config) => {
            config = innerConfig;
          }),
        ),
      isDebugging: process.env.DEBUG !== undefined,
      messenger: this.messenger,
      showFooter: false,
    });
    await ui.waitUntilExit();
    if (config) {
      return config;
    } else {
      throw new Error('Failed to read config');
    }
  }

  /**
   * Ask the user for the required configurations that are currently missing and write them to the closest config
   * file
   */
  private askForRequiredConfig(config: Config): Observable<Partial<Config>> {
    // TODO requiredConfig should be configurable by each command
    return from(requiredConfigs.filter((cfg) => path(cfg.path, config) === undefined)).pipe(
      concatMap((requiredConfig) =>
        this.messenger
          .request(requiredConfig.request)
          .pipe(map((value) => [requiredConfig.path, value])),
      ),
      reduce<[string[], string], Partial<Config>>((accumulator, value) => {
        return set(lensPath(value[0]), value[1], accumulator);
      }, {}),
      map(writeConfig),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async init(): Promise<any> {
    await this.initializeFotingoConfig();
    this.tracker = new Jira(this.fotingo.jira, this.messenger);
    this.git = new Git(this.fotingo.git, this.messenger);
    this.github = new Github(this.fotingo.github, this.messenger, this.git);
    return super.init();
  }

  async run(): Promise<void> {
    const { waitUntilExit } = renderUi({
      cmd: () => {
        const commandData = this.getCommandData();
        const commandData$ = commandData instanceof Observable ? commandData : of(commandData);
        return this.validate(commandData$).pipe(switchMap(() => this.runCmd(commandData$)));
      },
      isDebugging: process.env.DEBUG !== undefined,
      messenger: this.messenger,
    });
    try {
      await waitUntilExit();
    } catch {
      // eslint-disable-next-line no-process-exit, unicorn/no-process-exit
      process.exit(1);
    }
  }

  /**
   * Return if the current working directory is a git repo
   * @protected
   */
  @boundMethod
  protected isGitRepo(): Observable<boolean> {
    return from(this.git.getRootDir()).pipe(
      map(() => true),
      catchError((error) => of(error.code && error.code !== GitErrorType.NOT_A_GIT_REPO)),
    );
  }

  /**
   * Given the information for a branch, fetch from the tracker the information about
   * all the fixed issues
   * @param data
   */
  @boundMethod
  protected getLocalChangesInformation(
    data: [BranchInfo, { issues?: string[]; tracker: { enabled: boolean } }] | BranchInfo,
  ): ObservableInput<LocalChanges> {
    const [branchInfo, { issues = [], tracker }] = Array.isArray(data)
      ? data
      : [data, { issues: [], tracker: { enabled: true } }];
    if (!tracker.enabled) {
      return of({ branchInfo, issues: [] }) as ObservableInput<LocalChanges>;
    }

    const allIssues = concat(branchInfo.issues.map(prop('issue')), issues);

    if (allIssues.length > 0) {
      this.messenger.emit(`Getting information for ${allIssues.join(', ')}`, Emoji.BUG);
    }
    // TODO Use forkJoin
    return zip(
      of(branchInfo),
      merge(
        ...allIssues
          .filter((issue) => this.tracker.isValidIssueName(issue))
          .map((issue) =>
            this.tracker.getIssue(issue).pipe(
              // TODO Rename JiraError
              catchError((error: JiraError) => {
                if (error.code === 404) {
                  return EMPTY;
                }
                throw error;
              }),
            ),
          ),
      ).pipe(reduce<Issue, Issue[]>((accumulator, value) => [...accumulator, value], [])),
    ).pipe(map(zipObj(['branchInfo', 'issues']))) as unknown as ObservableInput<LocalChanges>;
  }

  protected getValidations(commandData$: Observable<R>): [() => Observable<boolean>, string][] {
    return [
      this.validations.isGitRepo(commandData$),
      this.validations.defaultBranchExist(commandData$),
    ];
  }

  /**
   * Validate the execution context before taking any action. The command will not run
   * if any error is thrown in this function
   * @param commandData$ The command data
   * @protected
   */
  private validate(commandData$: Observable<R>): Observable<void> {
    return merge(
      ...this.getValidations(commandData$).map(([validation, message]) =>
        validation().pipe(map(returnIfFalse(message))),
      ),
      // Add extra element so that if a command overrides getValidations to return an empty list
      // this still works
      of(undefined),
    ).pipe(
      switchMap((message) =>
        message === undefined ? of(undefined) : throwError(new Error(message)),
      ),
      last(),
    );
  }

  protected abstract getCommandData(): Observable<R> | R;

  protected abstract runCmd(commandData$: Observable<R>): Observable<T>;
}
