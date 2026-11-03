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
from pico_preprocess import preprocess_code, IncludeNotFoundError, trim_cart_to_tab
from pico_process import PicoContext, CartSource
from pico_tokenize import tokenize
from pico_srcdefs import Source

FLAGS = ['--minify-safe-only', '--no-minify-rename', '--no-minify-lines',
         '--focus-tokens', '--no-minify-transform']
COUNT_FLAGS = ['--input-count', '--count', '--parsable-count', '--error-format', 'common']


class Unsupported(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def engine_info():
    return json.dumps({'version': get_version(), 'pythonVersion': sys.version.split()[0]})


def preflight(path, kind, allowed):
    """Exercise upstream preprocessing while confining every open to the supplied file map.

    Tokenizer-derived expected includes also detect upstream's long-string preprocessing
    discrepancy. No source or custom Python scripts are evaluated.
    """
    stack, tab_targets, notes = [], set(), []
    visits = 0

    def fail(code, message):
        raise Unsupported(code, message)

    def preprocess(path, code, start_line=0, **kwargs):
        nonlocal visits
        visits += 1
        if visits > 1000:
            fail('E_INCLUDE_LIMIT', 'Include expansion exceeds 1000 source visits.')
        current = pathlib.Path(path).resolve()
        chain = ' → '.join(allowed.get(p, p.name) for p in [*stack, current])
        if current not in allowed:
            fail('E_INCLUDE_PATH', f'Include is outside the supplied file map: {chain}')
        if current in stack:
            fail('E_INCLUDE_CYCLE', f'Include cycle: {chain}')
        if len(stack) >= 50:
            fail('E_INCLUDE_LIMIT', f'Include depth exceeded: {chain}')
        tokens, _ = tokenize(Source(str(path), code), PicoContext(ignore_transforms=True, hint_comments=False), all_comments=True)
        expected = []
        for token in tokens:
            for comment in token.children:
                body = comment.value[2:]
                if comment.isblock:
                    match = re.match(r'\[(=*)\[(.*)\]\1\]$', body, re.S)
                    if match:
                        body = match.group(2)
                body = body.strip()
                head = body.split(':', 1)[0]
                if body.startswith('$') or head in ('deflanguage', 'language'):
                    fail('E_TRANSFORM_UNSUPPORTED', f'Compiler/preprocessor hint is unsupported in {allowed[current]}.')
                if body.startswith('@'):
                    notes.append({'severity': 'warning', 'code': 'W_BUILD_DIRECTIVE', 'message': f'Source-only project directive in {allowed[current]}; output is a build copy and may remove it. Keep the original project source.', 'file': allowed[current]})
            if token.value != '#' or code[code.rfind('\n', 0, token.idx) + 1:token.idx].strip():
                continue
            line = code[token.idx:].split('\n', 1)[0].strip()
            if not re.match(r'#[A-Za-z_]', line):
                continue
            parts = line.split(maxsplit=1)
            if parts[0] != '#include' or len(parts) != 2:
                fail('E_DIRECTIVE_UNSUPPORTED', f'Unsupported preprocessor directive in {allowed[current]}: {line}')
            name = parts[1]
            tab = re.fullmatch(r'(.*\.p8):([0-9])', name, re.I)
            relative = tab[1] if tab else name
            if (relative.startswith('/') or any(ch in relative for ch in ('\\', ':', '"', "'", '\0'))
                    or any(ord(ch) < 32 for ch in relative) or pathlib.PurePosixPath(relative).suffix.lower() not in ('.lua', '.p8')):
                fail('E_INCLUDE_PATH', f'Unsupported include path {name}. Chain: {chain}')
            target = (current.parent / relative).resolve()
            if target not in allowed:
                fail('E_INCLUDE_MISSING', f'Missing or unauthorized include: {chain} → {name}. Supply the exact relative path from the opened folder.')
            if tab:
                tab_targets.add(target)
                # Upstream selects only after whole-cart preprocessing. Check existence now
                # so a missing tab is a source diagnostic, not a generic engine exception.
                tab_cart = read_cart(str(target), preprocess_hook=lambda path, code, start_line=0, **kw: (code, []))
                try:
                    trim_cart_to_tab(tab_cart, int(tab[2]))
                except Exception:
                    fail('E_INCLUDE_TAB', f'Missing code tab {name}. Chain: {chain}')
            expected.append(target)
        if current in tab_targets and (expected or code.startswith('-->8') or re.search(r'^-->8[ \t]+$', code, re.M) or '\n-->8\n-->8\n' in code):
            fail('E_INCLUDE_SEMANTICS', f'Tab includes in {allowed[current]} differ between Suite and Shrinko8. Use a separate .lua dependency.')
        seen = 0

        def notify(included):
            nonlocal seen
            target = pathlib.Path(included).resolve()
            if seen >= len(expected) or target != expected[seen]:
                fail('E_INCLUDE_SEMANTICS', f'Suite/tokenizer and Shrinko8 preprocessing disagree in {allowed[current]}; no build was produced.')
            seen += 1

        stack.append(current)
        try:
            expanded = preprocess_code(path, code, start_line, include_notifier=notify, preprocess_hook=preprocess)
        except IncludeNotFoundError:
            fail('E_INCLUDE_SEMANTICS', f'Shrinko8 attempted an include not present in the tokenizer-validated tree: {chain}. No build was produced.')
        finally:
            stack.pop()
        if seen != len(expected):
            fail('E_INCLUDE_SEMANTICS', f'Shrinko8 did not resolve every source include in {allowed[current]}.')
        return expanded

    cart = read_cart(str(path), CartFormat(kind), preprocess_hook=preprocess)
    return cart, list({json.dumps(n, sort_keys=True): n for n in notes}.values())


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
            raise Unsupported('E_FORMAT_UNSUPPORTED', 'Use a .p8 or .lua file tree. PNG export is not packaged.')
        files = job.get('files', [])
        entry = job.get('entryPath', '')
        def valid_path(value):
            return (isinstance(value, str) and value and not any(ord(c) < 32 for c in value)
                    and not any(c in value for c in ('\\', ':'))
                    and all(p and p not in ('.', '..') for p in value.split('/'))
                    and pathlib.PurePosixPath(value).suffix.lower() in ('.lua', '.p8'))
        if not valid_path(entry) or pathlib.PurePosixPath(entry).suffix.lower() != '.' + kind or not isinstance(files, list) or not files:
            raise Unsupported('E_INPUT_INVALID', 'Provide matching relative .p8/.lua entry and plain file texts.')
        names = set()
        for file in files:
            if not isinstance(file, dict) or not valid_path(file.get('path')) or not isinstance(file.get('text'), str) or '\0' in file['text']:
                raise Unsupported('E_INPUT_INVALID', 'Source files need unique safe relative paths and plain text.')
            if file['path'].lower().endswith('.p8'):
                text = file['text'].replace('\r\n', '\n')
                if not text.startswith('pico-8 cartridge') or not re.match(r'version [0-9]+$', text.split('\n')[1] if '\n' in text else '') or text.count('\n__lua__\n') != 1:
                    raise Unsupported('E_CART_INVALID', f'Invalid text cartridge header/section: {file["path"]}')
            key = file['path'].lower()
            if key in names:
                raise Unsupported('E_INCLUDE_AMBIGUOUS', f'Ambiguous source path: {file["path"]}')
            names.add(key)
        if entry not in [f['path'] for f in files]:
            raise Unsupported('E_INPUT_INVALID', 'The exact entry path is missing from the file map.')
        with tempfile.TemporaryDirectory(prefix='suite-minifier-') as directory:
            root = pathlib.Path(directory)
            input_root = root / 'input'
            allowed = {}
            for file in files:
                path = input_root / file['path']
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(file['text'], encoding='utf-8', newline='')
                allowed[path.resolve()] = file['path']
            source = input_root / entry
            output = root / ('optimized.' + kind)
            stream = io.StringIO()
            with contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
                _, project_notes = preflight(source, kind, allowed)
                exit_code = main([str(source), str(output), '-F', kind, '-f', kind] + FLAGS + COUNT_FLAGS)
            failed = exit_code not in (None, 0, 2) or not output.is_file()
            notes = project_notes + diagnostics(stream.getvalue(), input_root, failed)
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
