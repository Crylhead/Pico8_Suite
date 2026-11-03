"""Suite-owned, fixed-argument bridge to unmodified pinned Shrinko8. No source execution."""
import contextlib
import io
import json
import pathlib
import re
import sys
import tempfile

from shrinko8 import main
from run_shrinko import get_version
from pico_cart import CartFormat, read_cart
from pico_defs import from_p8str
from pico_preprocess import preprocess_code, IncludeNotFoundError
from pico_process import PicoContext, CartSource
from pico_tokenize import tokenize

FLAGS = ['--minify-safe-only', '--no-minify-rename', '--no-minify-lines',
         '--focus-tokens', '--no-minify-transform']
COUNT_FLAGS = ['--input-count', '--count', '--parsable-count', '--error-format', 'common']


class Unsupported(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def engine_info():
    return json.dumps({'version': get_version(), 'pythonVersion': sys.version.split()[0]})


def reject_include(*args, **kwargs):
    raise Unsupported('E_INCLUDE_UNSUPPORTED', 'This worker currently accepts standalone files only. Project #include support belongs to MIN-07.')


def preflight(path, kind):
    def preprocess(path, code, start_line=0, **kwargs):
        return preprocess_code(path, code, start_line, include_notifier=reject_include, **kwargs)
    try:
        cart = read_cart(str(path), CartFormat(kind), preprocess_hook=preprocess)
    except IncludeNotFoundError:
        reject_include()
    # Use the real tokenizer: compiler-looking strings and ordinary comments are not directives.
    tokens, errors = tokenize(CartSource(cart), PicoContext(ignore_transforms=True, hint_comments=False), all_comments=True)
    for token in tokens:
        for comment in token.children:
            body = comment.value[2:]
            if comment.isblock:
                match = re.match(r'\[(=*)\[(.*)\]\1\]$', body, re.S)
                if match:
                    body = match.group(2)
            head = body.split(':', 1)[0]
            if head in ('$switch-compiler', '$dynamic-include', '$def-alias', 'deflanguage', '$deflanguage',
                        'language', '$language', '$placeholder-expr', '$placeholder-stmt'):
                raise Unsupported('E_TRANSFORM_UNSUPPORTED', 'Compiler, dynamic-include, sublanguage and placeholder hints are unsupported. The Suite does not compile Parens-8 or run custom scripts.')
    return cart


def diagnostics(text, root, failed):
    result = []
    for line in text.splitlines():
        if not line.strip() or line.startswith('count:') or line in ('Compilation errors:', 'Hint usage warnings:'):
            continue
        match = re.match(r'^(.+?):(\d+):(\d+): (.+)$', line)
        diagnostic = {'severity': 'error' if failed else 'warning', 'code': 'E_SHRINKO8' if failed else 'W_SHRINKO8', 'message': match[4] if match else line}
        if match:
            try:
                file = str(pathlib.Path(match[1]).resolve().relative_to(root))
            except ValueError:
                file = pathlib.Path(match[1]).name
            diagnostic.update(file=file, line=int(match[2]), column=int(match[3]))
        result.append(diagnostic)
    return result


def optimize(job_json):
    try:
        job = json.loads(job_json)
        if job.get('profile', 'minimal') != 'minimal' or job.get('target', 'tokens') != 'tokens':
            raise Unsupported('E_OPTIONS_UNSUPPORTED', 'This foundation worker supports Minimal + Tokens only.')
        kind = job.get('kind')
        if kind not in ('p8', 'lua'):
            raise Unsupported('E_FORMAT_UNSUPPORTED', 'Use a standalone .p8 or .lua file. PNG export is not packaged.')
        files = job.get('files', [])
        if len(files) != 1:
            reject_include()
        entry = job.get('entryPath', '')
        path = pathlib.PurePosixPath(entry)
        if (not entry or path.is_absolute() or any(p in ('..', '') for p in path.parts)
                or any(c in entry for c in ('\\', ':', '\0')) or path.suffix.lower() != '.' + kind
                or files[0].get('path') != entry or not isinstance(files[0].get('text'), str)):
            raise Unsupported('E_INPUT_INVALID', 'Provide one matching relative .p8/.lua entry path and plain source text.')
        text = files[0]['text']
        if kind == 'p8' and (not text.startswith('pico-8 cartridge') or '\n__lua__' not in text):
            raise Unsupported('E_CART_INVALID', 'A .p8 input needs its cartridge header and __lua__ section.')
        with tempfile.TemporaryDirectory(prefix='suite-minifier-') as directory:
            root = pathlib.Path(directory)
            source = root / entry
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text(text, encoding='utf-8', newline='')
            output = root / ('optimized.' + kind)
            stream = io.StringIO()
            with contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
                preflight(source, kind)
                exit_code = main([str(source), str(output), '-F', kind, '-f', kind] + FLAGS + COUNT_FLAGS)
            failed = exit_code not in (None, 0, 2) or not output.is_file()
            notes = diagnostics(stream.getvalue(), root, failed)
            if failed:
                return json.dumps({'ok': False, 'diagnostics': notes or [{'severity': 'error', 'code': 'E_SHRINKO8', 'message': 'Shrinko8 rejected the input.'}]})
            metrics = {'original': {}, 'optimized': {}}
            for prefix, name, value, limit in re.findall(r'^count:(input|None):([^:]+):(\d+):(\d+)$', stream.getvalue(), re.M):
                key = {'tokens': 'tokens', 'chars': 'characters', 'compressed': 'compressedBytes'}.get(name)
                if key:
                    metrics['original' if prefix == 'input' else 'optimized'][key] = int(value)
            for values in metrics.values():
                values.setdefault('compressedBytes', None)
                if 'tokens' not in values or 'characters' not in values:
                    raise ValueError('Pinned Shrinko8 did not emit the required token/character counts.')
                if values['compressedBytes'] is None:
                    values['compressedReason'] = 'This Shrinko8 invocation does not emit an input compressed count for plain source files.'
            result_text = output.read_text(encoding='utf-8')
            result_cart = read_cart(str(output), CartFormat(kind))
            return json.dumps({'ok': True, 'lua': from_p8str(result_cart.code),
                               'cartText': result_text if kind == 'p8' else None,
                               'metrics': metrics, 'diagnostics': notes, 'flags': FLAGS})
    except Unsupported as error:
        return json.dumps({'ok': False, 'diagnostics': [{'severity': 'error', 'code': error.code, 'message': str(error)}]})
    except Exception as error:
        # Report an actionable failure, never a fake unchanged success or a Python traceback.
        return json.dumps({'ok': False, 'diagnostics': [{'severity': 'error', 'code': 'E_INPUT_OR_ENGINE', 'message': str(error)}]})
