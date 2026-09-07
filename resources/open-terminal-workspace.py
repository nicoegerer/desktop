"""Launch the official Open Terminal with workspace-scoped file mutations.

This guards accidental stale absolute paths, not arbitrary code execution:
shell commands still have the desktop user's permissions. Reads are unchanged.
No installed package is modified, so runtime upgrades retain this behavior.
"""
import functools
import inspect
import os


def canonical(path):
    return os.path.normcase(os.path.realpath(os.path.abspath(os.fspath(path))))


def inside_workspace(root, path):
    try:
        return os.path.commonpath((root, canonical(path))) == root
    except (ValueError, OSError):
        return False


def install_workspace_write_guard(root, filesystem_type=None, error_type=None):
    if not root or not os.path.isdir(root):
        raise RuntimeError('A valid desktop workspace root is required')
    root = canonical(root)
    if filesystem_type is None:
        from open_terminal.utils.fs import UserFS
        filesystem_type = UserFS
    if error_type is None:
        from fastapi import HTTPException
        error_type = HTTPException

    mutations = {
        'write': ('path',), 'write_bytes': ('path',), 'mkdir': ('path',),
        'remove': ('path',), 'move': ('source', 'destination'),
    }
    # Validate the whole contract before modifying the class.
    for name, parameters in mutations.items():
        signature = inspect.signature(getattr(filesystem_type, name))
        if not all(parameter in signature.parameters for parameter in parameters):
            raise RuntimeError(f'Open Terminal filesystem contract changed: {name}')

    def wrap(original, parameters):
        signature = inspect.signature(original)

        @functools.wraps(original)
        async def guarded(*args, **kwargs):
            bound = signature.bind(*args, **kwargs)
            for parameter in parameters:
                destination = bound.arguments[parameter]
                if not inside_workspace(root, destination):
                    raise error_type(status_code=409, detail=(
                        f'Workspace mismatch: {destination!s} is outside the selected workspace {root}. '
                        'Do not reuse an output path from an earlier workspace. '
                        'Retry the file operation with a path inside the selected workspace. '
                        'To modify another folder, ask the user to select that workspace first.'
                    ))
            return await original(*args, **kwargs)

        return guarded

    for name, parameters in mutations.items():
        setattr(filesystem_type, name, wrap(getattr(filesystem_type, name), parameters))


if __name__ == '__main__':
    install_workspace_write_guard(os.environ.get('OPEN_WEBUI_DESKTOP_WORKSPACE_ROOT'))
    from open_terminal.cli import main
    main()
