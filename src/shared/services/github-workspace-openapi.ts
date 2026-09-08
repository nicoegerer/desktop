/** Small, scoped file toolset for the selected GitHub repository. */
export const githubWorkspaceOpenApi = (title: string): Record<string, unknown> => ({
  openapi: '3.1.0',
  info: {
    title: `GitHub workspace: ${title}`,
    version: '2.0.0',
    description:
      'Read and save files directly in the selected repository and branch. Writes create verified GitHub commits; no local checkout or shell.'
  },
  paths: {
    '/files/write': {
      post: {
        operationId: 'write_file',
        summary: 'Save a file in the selected GitHub workspace',
        description:
          'Create or replace a UTF-8 text file directly on the selected repository branch. Each call commits the file and verifies its contents. Use for requested file creation or edits, not a code block to copy. Relative paths only; no local filesystem access.',
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
        description: 'List files and directories in the active GitHub repository.',
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
