import { validateGithubScope, type GithubRequest, type GithubWriteScope } from './github-write'

const fail = (message: string, status = 400): Error => Object.assign(new Error(message), { status })
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const requireOk = async (response: Response): Promise<void> => {
  if (response.ok) return
  // Return the genuine HTTP status without leaking arbitrary GitHub response data.
  await response.body?.cancel()
  throw fail(
    `GitHub rejected the operation (HTTP ${response.status}). Check Pages write or Actions write permission. No successful deployment was verified.`,
    response.status
  )
}

/** Only the mount supplies repository/branch. The model cannot override either. */
export async function githubWorkspaceAction(
  scope: GithubWriteScope,
  value: unknown,
  request: GithubRequest,
  isActive: () => boolean = () => true
): Promise<Record<string, unknown>> {
  validateGithubScope(scope)
  if (!object(value) || value.user_requested !== true)
    throw fail(
      'This action requires an explicit user request in the current chat (user_requested=true).'
    )
  const fields: Record<string, string[]> = {
    pages_enable: ['action', 'user_requested'],
    workflow_dispatch: ['action', 'user_requested', 'workflow_id', 'inputs_json'],
    workflow_rerun: ['action', 'user_requested', 'run_id', 'failed_only']
  }
  const action = String(value.action ?? '')
  if (
    !Object.hasOwn(fields, action) ||
    Object.keys(value).some((key) => !fields[action].includes(key))
  )
    throw fail(
      'Unsupported action or argument. Repository, branch and API endpoints cannot be overridden.'
    )
  const base = '/repos/' + scope.repoFullName
  const active = (): void => {
    if (!isActive())
      throw fail('Workspace or GitHub connection changed; select it again before retrying.', 409)
  }
  const read = async (path: string): Promise<Response> => {
    active()
    return request(path, { cache: 'no-store', redirect: 'error' })
  }
  const post = async (path: string, body?: object): Promise<Response> => {
    active()
    // No automatic retries: a timed-out dispatch may already have started a run.
    return request(path, {
      method: 'POST',
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error'
    })
  }
  const result = {
    repository: scope.repoFullName,
    branch: scope.branch,
    action,
    deployment_verified: false
  }

  if (action === 'pages_enable') {
    const before = await read(base + '/pages')
    if (before.ok) {
      const pages = (await before.json()) as Record<string, unknown>
      if (pages.build_type !== 'workflow')
        throw fail(
          'Pages already uses another publishing source. It was not changed; switch the source explicitly in GitHub settings.',
          409
        )
      return {
        ...result,
        enabled: true,
        changed: false,
        html_url: pages.html_url,
        message:
          'Pages is enabled for Actions. Check the deployment workflow before claiming the website is live.'
      }
    }
    if (before.status !== 404) {
      await requireOk(before)
      throw fail('Unexpected Pages response.', 502)
    }
    await before.body?.cancel()
    const repository = await read(base)
    await requireOk(repository)
    const metadata = (await repository.json()) as Record<string, unknown>
    if (
      typeof metadata.full_name !== 'string' ||
      metadata.full_name.toLowerCase() !== scope.repoFullName.toLowerCase()
    )
      throw fail('Repository identity could not be verified.', 409)
    const created = await post(base + '/pages', { build_type: 'workflow' })
    await requireOk(created)
    await created.body?.cancel()
    const after = await read(base + '/pages')
    await requireOk(after)
    const pages = (await after.json()) as Record<string, unknown>
    if (pages.build_type !== 'workflow')
      throw fail(
        'Pages activation was requested but its configuration could not be verified. Check Pages status before retrying.',
        502
      )
    return {
      ...result,
      enabled: true,
      changed: true,
      html_url: pages.html_url,
      message:
        'Pages is enabled for Actions. No workflow was dispatched by this call and deployment success is not yet verified.'
    }
  }
  if (action === 'workflow_dispatch') {
    if (
      typeof value.workflow_id !== 'string' ||
      !/^(?:[1-9][0-9]{0,19}|[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml)$/.test(value.workflow_id)
    )
      throw fail('workflow_id must be a numeric ID or a workflow filename such as deploy.yml.')
    let inputs: Record<string, unknown> | undefined
    if (value.inputs_json !== undefined) {
      if (typeof value.inputs_json !== 'string' || value.inputs_json.length > 60_000)
        throw fail('Invalid workflow inputs.')
      try {
        inputs = JSON.parse(value.inputs_json)
      } catch {
        throw fail('inputs_json must contain a JSON object.')
      }
      if (
        !object(inputs) ||
        Object.keys(inputs).length > 25 ||
        Object.values(inputs).some((v) => !['string', 'number', 'boolean'].includes(typeof v))
      )
        throw fail('Workflow inputs must be an object of at most 25 strings, numbers or booleans.')
    }
    const endpoint = base + '/actions/workflows/' + value.workflow_id
    const workflow = await read(endpoint)
    await requireOk(workflow)
    await workflow.body?.cancel()
    const branch = await read(base + '/branches/' + encodeURIComponent(scope.branch))
    await requireOk(branch)
    await branch.body?.cancel()
    const response = await post(endpoint + '/dispatches', {
      ref: scope.branch,
      ...(inputs ? { inputs } : {})
    })
    await requireOk(response)
    await response.body?.cancel()
    return {
      ...result,
      accepted: true,
      workflow_id: value.workflow_id,
      message:
        'Dispatch accepted, not completed. Read Actions runs for this branch and verify the conclusion. Do not automatically dispatch again if the new run is not visible yet.'
    }
  }
  if (
    typeof value.run_id !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(value.run_id) ||
    (value.failed_only !== undefined && typeof value.failed_only !== 'boolean')
  )
    throw fail('A numeric run_id and optional boolean failed_only are required.')
  const endpoint = base + '/actions/runs/' + value.run_id
  const response = await read(endpoint)
  await requireOk(response)
  const run = (await response.json()) as Record<string, unknown>
  if (
    String(run.id) !== value.run_id ||
    run.head_branch !== scope.branch ||
    !object(run.head_repository) ||
    String(run.head_repository.full_name).toLowerCase() !== scope.repoFullName.toLowerCase()
  )
    throw fail(
      'This run does not belong to the selected repository branch. Fork runs cannot be rerun here.',
      409
    )
  if (run.status !== 'completed')
    throw fail('This workflow is still active; it was not started a second time.', 409)
  const rerun = await post(
    endpoint + (value.failed_only === false ? '/rerun' : '/rerun-failed-jobs')
  )
  await requireOk(rerun)
  await rerun.body?.cancel()
  return {
    ...result,
    accepted: true,
    run_id: value.run_id,
    previous_attempt: run.run_attempt,
    message:
      'Rerun accepted, not completed. Check the new run attempt and conclusion before reporting success.'
  }
}
