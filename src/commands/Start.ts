import { compose, has, ifElse, pathEq, prop, tap as rTap, unapply, zipObj } from 'ramda';
import { Observable, of } from 'rxjs';
import { map, switchMap, tap, withLatestFrom } from 'rxjs/operators';
import { FotingoArguments } from 'src/commands/FotingoArguments';
import { Git } from 'src/git/Git';
import { Emoji, Messenger } from 'src/io/messenger';
import { Jira } from 'src/issue-tracker/jira/Jira';
import { Tracker } from 'src/issue-tracker/Tracker';
import { CreateIssue, GetIssue, Issue, IssueStatus, IssueType } from 'src/types';

interface StartData {
  git: {
    createBranch: boolean;
  };
  issue: CreateIssue | GetIssue;
}

interface IssueAndStartData {
  commandData: StartData;
  issue: Issue;
}

const getCommandData = (args: FotingoArguments): StartData => {
  return {
    git: {
      createBranch: !args.noBranchIssue,
    },
    issue: args.create
      ? {
          description: args.description as string,
          labels: args.labels as string[],
          project: args.project as string,
          title: args.issueTitle as string,
          type: args.type as IssueType,
        }
      : { id: args.issueId as string },
  };
};

const getOrCreateIssue = (
  tracker: Tracker,
  messenger: Messenger,
): ((data: StartData) => Observable<Issue>) =>
  compose(
    ifElse(
      has('id'),
      compose(
        tracker.getIssue,
        rTap(id => {
          messenger.emit(`Getting ${id} from Jira`, Emoji.BUG);
        }),
        prop('id'),
      ),
      compose(
        tracker.createIssueForCurrentUser,
        rTap(() => {
          messenger.emit('Creating issue in Jira', Emoji.BUG);
        }),
      ),
    ),
    prop('issue'),
  );

const setIssueInProgress = (tracker: Tracker): ((data: Issue) => Observable<Issue>) =>
  compose((id: string) => tracker.setIssueStatus(IssueStatus.IN_PROGRESS, id), prop('key'));

const shouldCreateBranch = pathEq(['commandData', 'git', 'createBranch'], true);

const createBranch = (
  git: Git,
  messenger: Messenger,
): ((data: IssueAndStartData) => Promise<void>) =>
  compose(
    git.createBranchAndStashChanges,
    rTap(name => {
      messenger.emit(`Creating branch ${name}`, Emoji.TADA);
    }),
    git.getBranchNameForIssue,
    prop('issue'),
  );

const justReturnTheIssue: (
  data: IssueAndStartData,
) => Observable<Issue> = compose((data: IssueAndStartData) => of(prop('issue', data)));

export const cmd = (args: FotingoArguments, messenger: Messenger): Observable<void | Issue> => {
  const tracker: Tracker = new Jira(args.config.jira, messenger);
  const git: Git = new Git(args.config.git, messenger);
  const commandData$ = of(args).pipe(map(getCommandData));
  return commandData$.pipe(
    switchMap(getOrCreateIssue(tracker, messenger)),
    tap((issue: Issue) => {
      messenger.emit(`Setting ${issue.key} in progress`, Emoji.BOOKMARK);
    }),
    switchMap(setIssueInProgress(tracker)),
    withLatestFrom(commandData$, unapply(zipObj(['issue', 'commandData']))),
    switchMap<IssueAndStartData, Observable<void | Issue>>(
      ifElse(shouldCreateBranch, compose(createBranch(git, messenger)), justReturnTheIssue),
    ),
  );
};
