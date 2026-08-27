/** OpenAPI surface exposed by a read-only GitHub workspace mount. */
export const githubWorkspaceOpenApi = (title: string): Record<string, unknown> => ({
  openapi: '3.1.0',
  info: {
    title: `GitHub workspace: ${title}`,
    version: '1.0.0',
    description: 'Read-only repository files. Use the GitHub connector to commit changes.'
  },
  paths: {
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
