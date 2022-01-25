import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as simpleGitMock from 'simple-git/promise';
import { Git } from 'src/git/Git';
import { GitErrorType } from 'src/git/GitError';
import { Messenger } from 'src/io/messenger';
import { data } from 'test/lib/data';

jest.mock('simple-git/promise');

const simpleGit = simpleGitMock as unknown as ReturnType<typeof jest.fn>;

let git: Git;
let branchName: string;
let remoteBranch: string;
const latestCommitHash = '547433c';
const remote = 'git@github.com:tagoro9/fotingo-rewrite.git';

const gitMocks = {
  branch: jest.fn<Promise<unknown>, []>().mockResolvedValue({ all: ['remotes/origin/master'] }),
  branchLocal: jest.fn<Promise<unknown>, []>().mockResolvedValue({ all: [] }),
  checkoutBranch: jest.fn<Promise<unknown>, []>().mockResolvedValue(undefined),
  fetch: jest.fn<Promise<unknown>, []>().mockResolvedValue(undefined),
  getRemotes: jest.fn<Promise<unknown>, []>().mockResolvedValue([
    {
      name: 'origin',
      refs: {
        fetch: remote,
        push: remote,
      },
    },
  ]),
  log: jest.fn<Promise<unknown>, []>().mockResolvedValue(undefined),
  push: jest.fn<Promise<unknown>, []>().mockResolvedValue(undefined),
  raw: jest.fn<Promise<unknown>, []>().mockResolvedValue(undefined),
  revparse: jest.fn<Promise<unknown>, []>().mockResolvedValue(undefined),
  stash: jest.fn<Promise<unknown>, []>().mockResolvedValue(undefined),
  status: jest.fn<Promise<unknown>, []>().mockResolvedValue({
    files: [],
  }),
};

describe('Git', () => {
  beforeEach(() => {
    const issue = data.createIssue();
    const gitConfig = data.createGitConfig();
    branchName = issue.key;
    remoteBranch = `remotes/${gitConfig.remote}/${gitConfig.baseBranch}`;
    gitMocks.revparse.mockResolvedValue(branchName);
    gitMocks.log.mockResolvedValue({
      latest: {
        hash: latestCommitHash,
      },
    });
    simpleGit.mockReturnValue({ ...gitMocks });
    git = new Git(gitConfig, new Messenger());
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getBranchNameForIssue', () => {
    it('should generate a branch name for an issue', () => {
      expect(git.getBranchNameForIssue(data.createIssue())).toMatchSnapshot();
    });
  });

  describe('push', () => {
    it('should do a git push', async () => {
      await git.push();
      expect(gitMocks.push).toBeCalledTimes(1);
    });
  });

  describe('createBranchAndStashChanges', () => {
    it('should fetch and create a branch from the latest commit', async () => {
      await git.createBranchAndStashChanges(branchName);
      expect(gitMocks.fetch).toHaveBeenCalledTimes(1);
      expect(gitMocks.status).toHaveBeenCalledTimes(1);
      expect(gitMocks.log).toHaveBeenCalledWith(['-n1', remoteBranch]);
      expect(gitMocks.checkoutBranch).toHaveBeenCalledWith(branchName, latestCommitHash);
      expect(gitMocks.stash).not.toHaveBeenCalled();
    });

    it('should stash any existing change before creating the branch', async () => {
      gitMocks.status.mockResolvedValue({ files: ['some file.txt'] });
      await git.createBranchAndStashChanges(branchName);
      expect(gitMocks.fetch).toHaveBeenCalledTimes(1);
      expect(gitMocks.stash).toHaveBeenCalledWith([
        'save',
        '--include-untracked',
        'Auto generated by fotingo',
      ]);
      expect(gitMocks.status).toHaveBeenCalledTimes(1);
      expect(gitMocks.log).toHaveBeenCalledWith(['-n1', remoteBranch]);
      expect(gitMocks.checkoutBranch).toHaveBeenCalledWith(branchName, latestCommitHash);
    });

    it('should throw an error if a branch already exists', async () => {
      gitMocks.checkoutBranch.mockRejectedValue(
        new Error(`A branch named ${branchName} already exists`),
      );
      await expect(git.createBranchAndStashChanges(branchName)).rejects.toMatchObject(
        expect.objectContaining({ code: GitErrorType.BRANCH_ALREADY_EXISTS }),
      );
    });
  });

  describe('getRemote', () => {
    it('should return the parsed remote', async () => {
      await expect(git.getRemote('origin')).resolves.toMatchSnapshot();
      expect(gitMocks.getRemotes).toHaveBeenCalledWith(true);
    });

    it('should fall back to the first remote if it cannot find the specified one', async () => {
      await expect(git.getRemote('some_remote')).resolves.toMatchSnapshot();
      expect(gitMocks.getRemotes).toHaveBeenCalledWith(true);
    });

    it('should throw an error if there are no remotes', async () => {
      gitMocks.getRemotes.mockResolvedValue([]);
      await expect(git.getRemote('origin')).rejects.toMatchInlineSnapshot(
        `[Error: The repository does not have a remote]`,
      );
    });
  });

  describe('getBranchInfo', () => {
    it('should return the parsed commit history', async () => {
      const baseCommit = {
        author_email: 'test@fotingo.com',
        author_name: 'Fotingo',
        date: 'Fri Jun 26 08:09:23 2020 -0700',
      };
      const commits = [
        {
          ...baseCommit,
          hash: '570768fc6dee7d8983d323555146eb9529f0b701',
          message: 'fix(something): fix this\n\nFixes #FOTINGO-123',
        },
        {
          ...baseCommit,
          hash: 'bf4cf25bdfa6f9c9fffd6226a55071620b1e83a2',
          message: 'feat(that): implement that\n\nfixes #FOTINGO-12',
        },
        {
          ...baseCommit,
          hash: '3955a5ec9ed98ae53ebd49a70bed0a0523a08d61',
          message: 'chore: improve this\n\nFixes #FOTINGO-1',
        },
      ];
      gitMocks.raw.mockResolvedValue(commits[0].hash);
      gitMocks.log.mockResolvedValue({ all: commits });
      await expect(git.getBranchInfo()).resolves.toMatchSnapshot();
    });
  });
});
