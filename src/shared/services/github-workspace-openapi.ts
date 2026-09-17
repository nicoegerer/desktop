/** Small, scoped file toolset for the selected GitHub repository. */
export const githubWorkspaceOpenApi = (title: string): Record<string, unknown> => ({
  openapi: '3.1.0',
  info: {
    title: `GitHub workspace: ${title}`,
    version: '3.0.0',
    description:
      'Read and save files directly in the selected repository and branch. Writes create verified GitHub commits; no local checkout or shell.'
  },
  paths: {
    '/github/action': {
      post: {
        operationId: 'github_workspace_action',
        summary: 'Enable Pages or start/rerun a workflow in the selected repository',
        description:
          'Use ONLY when the user explicitly requests this operation or deployment in the current chat. Pages activation can publish a website. The repository and branch are fixed by the current workspace; they cannot be supplied or overridden. pages_enable enables GitHub Actions as the Pages source without changing an existing legacy/custom setup. workflow_dispatch starts a workflow on this branch; workflow_rerun reruns a completed run from this same repository branch (failed jobs by default). No repository deletion or account administration. A successful response means configured/accepted, NEVER deployed successfully: use github_api_read and github_actions_logs to verify actual run status. Do not blindly repeat an uncertain dispatch.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['action', 'user_requested'],
                properties: {
                  action: {
                    type: 'string',
                    enum: ['pages_enable', 'workflow_dispatch', 'workflow_rerun']
                  },
                  user_requested: {
                    type: 'boolean',
                    description:
                      'True only when the current user request authorizes this operation/deployment.'
                  },
                  workflow_id: {
                    type: 'string',
                    description:
                      'For dispatch only: numeric workflow ID or filename such as deploy.yml.'
                  },
                  inputs_json: {
                    type: 'string',
                    description:
                      'For dispatch only: optional JSON object of workflow inputs. Branch/ref is supplied by the workspace.'
                  },
                  run_id: {
                    type: 'string',
                    description: 'For rerun only: numeric run ID on the selected branch.'
                  },
                  failed_only: {
                    type: 'boolean',
                    default: true,
                    description: 'For rerun only: false reruns all jobs.'
                  }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Verified configuration or accepted run, not deployment success.' },
          '403': { description: 'GitHub denied Pages/Actions write access.' },
          '409': {
            description: 'Workspace/branch mismatch or existing Pages source was preserved.'
          }
        },
        security: [{ HTTPBearer: [] }]
      }
    },
    '/files/write': {
      post: {
        operationId: 'write_file',
        summary: 'Save a file in the selected GitHub workspace',
        description:
          'Create or replace a UTF-8 text file directly on the selected repository branch. Also works in an empty repository: the first file creates the first commit. Each call commits the file and verifies its contents. Use for requested file creation or edits, not a code block to copy. Relative paths only; no local filesystem access.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['path', 'content'],
                additionalProperties: false,
                properties: {
                  path: {
                    type: 'string',
                    description: 'Repository-relative file path, for example index.html.'
                  },
                  content: {
                    type: 'string',
                    description: 'Complete UTF-8 file contents, at most 1 MB.'
                  },
                  message: { type: 'string', description: 'Optional concise commit message.' }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Verified commit, repository, branch and file path.' },
          '403': { description: 'Missing write permission or protected branch.' },
          '409': { description: 'Conflicting change; read the current file before retrying.' }
        },
        security: [{ HTTPBearer: [] }]
      }
    },
    '/files/list': {
      get: {
        operationId: 'list_files',
        summary: 'List repository files',
        description:
          'List files and directories in the active GitHub repository. An empty root listing is a valid new repository; use write_file to create its first file.',
        parameters: [
          {
            name: 'directory',
            in: 'query',
            required: false,
            schema: { type: 'string', default: '' }
          }
        ],
        responses: { '200': { description: 'Repository directory listing' } },
        security: [{ HTTPBearer: [] }]
      }
    },
    '/files/read': {
      get: {
        operationId: 'read_file',
        summary: 'Read a repository file',
        description: 'Read a text file from the active GitHub repository.',
        parameters: [
          { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
          {
            name: 'start_line',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1 }
          },
          {
            name: 'end_line',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1 }
          }
        ],
        responses: { '200': { description: 'Text file contents' } },
        security: [{ HTTPBearer: [] }]
      }
    }
  },
  components: {
    securitySchemes: { HTTPBearer: { type: 'http', scheme: 'bearer' } }
  }
})
