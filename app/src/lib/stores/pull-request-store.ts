import {
  PullRequestDatabase,
  IPullRequest,
  IPullRequestStatus,
} from '../databases'
import { GitHubRepository } from '../../models/github-repository'
import { Account } from '../../models/account'
import { API, IAPIPullRequest } from '../api'
import { fatalError, forceUnwrap } from '../fatal-error'
import { RepositoriesStore } from './repositories-store'
import {
  PullRequest,
  PullRequestRef,
  PullRequestStatus,
} from '../../models/pull-request'
import { Emitter, Disposable } from 'event-kit'
import { Repository } from '../../models/repository'
import { getRemotes, removeRemote } from '../git'
import { IRemote } from '../../models/remote'

/**
 * This is the magic remote name prefix
 * for when we add a remote on behalf of
 * the user.
 */
export const ForkedRemotePrefix = 'github-desktop-'

/** The store for GitHub Pull Requests. */
export class PullRequestStore {
  private readonly emitter = new Emitter()
  private readonly _pullRequestDb: PullRequestDatabase
  private readonly _repositoryStore: RepositoriesStore

  private activeFetchCountPerRepository = new Map<number, number>()

  public constructor(
    db: PullRequestDatabase,
    repositoriesStore: RepositoriesStore
  ) {
    this._pullRequestDb = db
    this._repositoryStore = repositoriesStore
  }

  /** Loads all pull requests against the given repository. */
  public async fetchPullRequests(
    repository: Repository,
    account: Account
  ): Promise<void> {
    const githubRepo = forceUnwrap(
      'Can only refresh pull requests for GitHub repositories',
      repository.gitHubRepository
    )
    const api = API.fromAccount(account)

    this.changeActiveFetchCount(githubRepo, c => c + 1)

    try {
      const apiResult = await api.fetchPullRequests(
        githubRepo.owner.login,
        githubRepo.name,
        'open'
      )

      await this.writePRs(apiResult, githubRepo)

      const prs = await this.loadPullRequestsFromCache(githubRepo)

      await this.refreshStatusForPRs(prs, githubRepo, account)
      await this.pruneForkedRemotes(repository, prs)
    } catch (error) {
      log.warn(`Error refreshing pull requests for '${repository.name}'`, error)
      this.emitError(error)
    } finally {
      this.changeActiveFetchCount(githubRepo, c => c - 1)
    }
  }

  private async pruneForkedRemotes(
    repository: Repository,
    pullRequests: ReadonlyArray<PullRequest>
  ) {
    const remotes = await getRemotes(repository)
    const forkedRemotesToDelete = this.forkedRemotesToDelete(
      remotes,
      pullRequests
    )

    await this.deleteForkedRemotes(repository, forkedRemotesToDelete)
  }

  private forkedRemotesToDelete(
    remotes: ReadonlyArray<IRemote>,
    openPullRequests: ReadonlyArray<PullRequest>
  ): ReadonlyArray<IRemote> {
    const forkedRemotes = remotes.filter(remote =>
      remote.name.startsWith(ForkedRemotePrefix)
    )
    const remotesOfPullRequests = new Set<string>()
    openPullRequests.forEach(openPullRequest => {
      const { gitHubRepository } = openPullRequest.head
      if (gitHubRepository != null && gitHubRepository.cloneURL != null) {
        remotesOfPullRequests.add(gitHubRepository.cloneURL)
      }
    })
    const forkedRemotesToDelete = forkedRemotes.filter(
      forkedRemote => !remotesOfPullRequests.has(forkedRemote.url)
    )

    return forkedRemotesToDelete
  }

  private async deleteForkedRemotes(
    repository: Repository,
    remotes: ReadonlyArray<IRemote>
  ) {
    for (const remote of remotes) {
      await removeRemote(repository, remote.name)
    }
  }

  private changeActiveFetchCount(
    repository: GitHubRepository,
    fn: (count: number) => number
  ) {
    const key = forceUnwrap(
      'Cannot fetch PRs for a repository which is not in the database',
      repository.dbID
    )
    const currentCount = this.activeFetchCountPerRepository.get(key) || 0
    const newCount = fn(currentCount)
    this.activeFetchCountPerRepository.set(key, newCount)

    this.emitUpdate(repository)
  }

  /** Is the store currently fetching the list of open pull requests? */
  public isFetchingPullRequests(repository: GitHubRepository): boolean {
    const key = forceUnwrap(
      'Cannot fetch PRs for a repository which is not in the database',
      repository.dbID
    )

    const currentCount = this.activeFetchCountPerRepository.get(key) || 0
    return currentCount > 0
  }

  /** Loads the status for the given pull request. */
  public async refreshSinglePullRequestStatus(
    repository: GitHubRepository,
    account: Account,
    pullRequest: PullRequest
  ): Promise<void> {
    await this.refreshStatusForPRs([pullRequest], repository, account)
  }

  /** Loads the status for all pull request against a given repository. */
  public async fetchPullRequestStatuses(
    repository: GitHubRepository,
    account: Account
  ): Promise<void> {
    const prs = await this.loadPullRequestsFromCache(repository)

    await this.refreshStatusForPRs(prs, repository, account)
  }

  private async refreshStatusForPRs(
    pullRequests: ReadonlyArray<PullRequest>,
    repository: GitHubRepository,
    account: Account
  ): Promise<void> {
    const api = API.fromAccount(account)
    const prStatuses: Array<IPullRequestStatus> = []
    //const prs: Array<PullRequest> = []

    for (const pr of pullRequests) {
      const combinedRefStatus = await api.fetchCombinedRefStatus(
        repository.owner.login,
        repository.name,
        pr.head.sha
      )

      prStatuses.push({
        pullRequestId: pr.id,
        state: combinedRefStatus.state,
        totalCount: combinedRefStatus.total_count,
        sha: pr.head.sha,
        statuses: combinedRefStatus.statuses,
      })
    }

    await this.cachePullRequestStatuses(prStatuses)
    this.emitUpdate(repository)
  }

  private async findPullRequestStatus(
    sha: string,
    pullRequestId: number
  ): Promise<PullRequestStatus | null> {
    const result = await this._pullRequestDb.pullRequestStatus
      .where('[sha+pullRequestId]')
      .equals([sha, pullRequestId])
      .limit(1)
      .first()

    if (!result) {
      return null
    }

    const combinedRefStatuses = result.statuses.map(x => {
      return {
        id: x.id,
        state: x.state,
      }
    })

    return new PullRequestStatus(
      result.pullRequestId,
      result.state,
      result.totalCount,
      result.sha,
      combinedRefStatuses
    )
  }

  private async writePRs(
    pullRequests: ReadonlyArray<IAPIPullRequest>,
    repository: GitHubRepository
  ): Promise<void> {
    const repoId = repository.dbID

    if (!repoId) {
      fatalError(
        "Cannot store pull requests for a repository that hasn't been inserted into the database!"
      )

      return
    }

    const table = this._pullRequestDb.pullRequests

    const insertablePRs = new Array<IPullRequest>()
    for (const pr of pullRequests) {
      let headRepo: GitHubRepository | null = null
      if (pr.head.repo) {
        headRepo = await this._repositoryStore.findOrPutGitHubRepository(
          repository.endpoint,
          pr.head.repo
        )
      }

      // We know the base repo isn't null since that's where we got the PR from
      // in the first place.
      const baseRepo = await this._repositoryStore.findOrPutGitHubRepository(
        repository.endpoint,
        forceUnwrap('PR cannot have a null base repo', pr.base.repo)
      )

      insertablePRs.push({
        number: pr.number,
        title: pr.title,
        createdAt: pr.created_at,
        head: {
          ref: pr.head.ref,
          sha: pr.head.sha,
          repoId: headRepo ? headRepo.dbID! : null,
        },
        base: {
          ref: pr.base.ref,
          sha: pr.base.sha,
          repoId: forceUnwrap('PR cannot have a null base repo', baseRepo.dbID),
        },
        author: pr.user.login,
      })
    }

    await this._pullRequestDb.transaction('rw', table, async () => {
      await table.clear()
      return await table.bulkAdd(insertablePRs)
    })
  }

  private async cachePullRequestStatuses(
    statuses: Array<IPullRequestStatus>
  ): Promise<void> {
    const table = this._pullRequestDb.pullRequestStatus

    await this._pullRequestDb.transaction('rw', table, async () => {
      for (const status of statuses) {
        const record = await table
          .where('[sha+pullRequestId]')
          .equals([status.sha, status.pullRequestId])
          .first()

        if (record == null) {
          await table.add(status)
        } else {
          await table.put({ id: record.id, ...status })
        }
      }
    })
  }

  /** Gets the pull requests against the given repository. */
  public async loadPullRequestsFromCache(
    repository: GitHubRepository
  ): Promise<ReadonlyArray<PullRequest>> {
    const gitHubRepositoryID = repository.dbID

    if (gitHubRepositoryID == null) {
      return fatalError(
        "Cannot get pull requests for a repository that hasn't been inserted into the database!"
      )
    }

    const records = await this._pullRequestDb.pullRequests
      .where('base.repoId')
      .equals(gitHubRepositoryID)
      .reverse()
      .sortBy('number')

    const result = new Array<PullRequest>()

    for (const record of records) {
      const repositoryDbId = record.head.repoId
      let githubRepository: GitHubRepository | null = null

      if (repositoryDbId != null) {
        githubRepository = await this._repositoryStore.findGitHubRepositoryByID(
          repositoryDbId
        )
      }

      // We know the base repo ID can't be null since it's the repository we
      // fetched the PR from in the first place.
      const parentRepositoryDbId = forceUnwrap(
        'PR cannot have a null base repo id',
        record.base.repoId
      )
      const parentGitHubRepository = forceUnwrap(
        'PR cannot have a null base repo',
        await this._repositoryStore.findGitHubRepositoryByID(
          parentRepositoryDbId
        )
      )

      // We can be certain the PR ID is valid since we just got it from the
      // database.
      const pullRequestDbId = forceUnwrap(
        'PR cannot have a null ID after being retrieved from the database',
        record.id
      )

      const pullRequestStatus = await this.findPullRequestStatus(
        record.head.sha,
        pullRequestDbId
      )

      const pullRequest = new PullRequest(
        pullRequestDbId,
        new Date(record.createdAt),
        pullRequestStatus,
        record.title,
        record.number,
        new PullRequestRef(record.head.ref, record.head.sha, githubRepository),
        new PullRequestRef(
          record.base.ref,
          record.base.sha,
          parentGitHubRepository
        ),
        record.author
      )

      result.push(pullRequest)
    }

    return result
  }

  private emitUpdate(repository: GitHubRepository) {
    this.emitter.emit('did-update', repository)
  }

  private emitError(error: Error) {
    this.emitter.emit('did-error', error)
  }

  /** Register a function to be called when the store updates. */
  public onDidUpdate(fn: (repository: GitHubRepository) => void): Disposable {
    return this.emitter.on('did-update', fn)
  }

  /** Register a function to be called when an error occurs. */
  public onDidError(fn: (error: Error) => void): Disposable {
    return this.emitter.on('did-error', fn)
  }
}
