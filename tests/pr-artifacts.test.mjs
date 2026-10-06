import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(
  new URL('../.github/workflows/pr-artifacts.yml', import.meta.url),
  'utf8'
)
const script = workflow.split('          script: |\n')[1].replace(/^ {12}/gm, '')
const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
  'github',
  'context',
  script
)

test('PR archive links replace their block, preserve prose and reject stale or incomplete builds', async () => {
  let body = 'Original description'
  let head = 'abcdef123'
  let updates = 0
  const artifacts = [
    { name: 'MegaProxy-chromium', id: 10 },
    { name: 'MegaProxy-firefox', id: 11 }
  ]
  const github = {
    paginate: async () => artifacts,
    rest: {
      actions: { listWorkflowRunArtifacts() {} },
      pulls: {
        get: async () => ({ data: { number: 1, state: 'open', head: { sha: head }, body } }),
        update: async data => {
          body = data.body
          updates++
        }
      }
    }
  }
  const run = {
    id: 42,
    head_sha: head,
    html_url: 'https://github.com/owner/repo/actions/runs/42',
    conclusion: 'success',
    pull_requests: [{ number: 1 }]
  }
  const context = { repo: { owner: 'owner', repo: 'repo' }, payload: { workflow_run: run } }
  await execute(github, context)
  assert.ok(body.startsWith('Original description\n\n'))
  assert.ok(body.includes('/actions/runs/42/artifacts/10'))
  body = body.replace('Original description', 'Edited description')
  run.id = 43
  await execute(github, context)
  assert.ok(body.startsWith('Edited description\n\n'))
  assert.equal(body.match(/## Installation archives/g).length, 1)
  assert.ok(body.includes('/actions/runs/43/artifacts/11'))
  assert.ok(!body.includes('/actions/runs/42/artifacts/'))
  head = 'newer'
  await execute(github, context)
  head = run.head_sha
  artifacts[1].expired = true
  await execute(github, context)
  assert.equal(updates, 2)
})

test('release archive links find merged PRs by commit when workflow metadata has no PRs', async () => {
  let update
  let associatedLookups = 0
  const github = {
    paginate: async (method, args) => {
      if (method === github.rest.actions.listWorkflowRunArtifacts) {
        return [
          { name: 'MegaProxy-chromium', id: 10 },
          { name: 'MegaProxy-firefox', id: 11 }
        ]
      }
      assert.equal(method, github.rest.repos.listPullRequestsAssociatedWithCommit)
      assert.equal(args.commit_sha, 'release-head')
      associatedLookups++
      return [{ number: 8 }, { number: 9 }]
    },
    rest: {
      actions: { listWorkflowRunArtifacts() {} },
      repos: { listPullRequestsAssociatedWithCommit() {} },
      pulls: {
        get: async ({ pull_number }) => ({
          data: {
            number: pull_number,
            state: 'closed',
            head: { sha: pull_number === 8 ? 'release-head' : 'newer-head' },
            body: 'Release notes'
          }
        }),
        update: async data => {
          assert.equal(data.pull_number, 8, 'Ignore associated PRs with a different head')
          update = data
        }
      }
    }
  }
  await execute(github, {
    repo: { owner: 'owner', repo: 'repo' },
    payload: {
      workflow_run: {
        id: 42,
        head_sha: 'release-head',
        html_url: 'https://github.com/owner/repo/actions/runs/42',
        conclusion: 'success',
        pull_requests: []
      }
    }
  })
  assert.equal(associatedLookups, 1)
  assert.ok(update.body.startsWith('Release notes\n\n'))
  assert.ok(update.body.includes('/artifacts/10'))
  assert.ok(update.body.includes('/artifacts/11'))
})
