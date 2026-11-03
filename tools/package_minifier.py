#!/usr/bin/env python3
"""Materialize pinned, local-only Minifier assets. No npm/build step or runtime CDN."""
import argparse
import hashlib
import io
import json
import pathlib
import tarfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]


def verify(data, expected, label):
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f"SHA-256 mismatch: {label}; no asset was installed")


def archive_bytes(record, local):
    if local:
        data = pathlib.Path(local).read_bytes()
    else:
        with urllib.request.urlopen(record['url'], timeout=90) as response:
            data = response.read()
    verify(data, record['sha256'], record['url'])
    return data


def prepare(lock, shrinko_archive, pyodide_archive):
    """Verify everything before writing; never extract arbitrary archive paths or links."""
    assets = {}
    shrinko = lock['shrinko8']
    with tarfile.open(fileobj=io.BytesIO(shrinko_archive)) as source:
        prefix = 'shrinko8-' + shrinko['commit'] + '/'
        bundle = io.BytesIO()
        with zipfile.ZipFile(bundle, 'w', compression=zipfile.ZIP_STORED) as output:
            for name in shrinko['modules']:
                if '/' in name or '\\' in name or not name.endswith('.py'):
                    raise ValueError('Invalid engine module name')
                entry = source.getmember(prefix + name)
                if not entry.isfile():
                    raise ValueError('Engine source is not a regular file')
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                output.writestr(info, source.extractfile(entry).read())
        data = bundle.getvalue()
        verify(data, shrinko['bundleSha256'], 'Shrinko8 module bundle')
        assets['vendor/shrinko8/runtime/engine.zip'] = data
    with tarfile.open(fileobj=io.BytesIO(pyodide_archive)) as source:
        for name, expected in lock['pyodide']['files'].items():
            if '/' in name or '\\' in name:
                raise ValueError('Invalid runtime asset name')
            entry = source.getmember('package/' + name)
            if not entry.isfile():
                raise ValueError('Runtime asset is not a regular file')
            data = source.extractfile(entry).read()
            verify(data, expected['sha256'], name)
            if len(data) != expected['bytes']:
                raise ValueError('Runtime size mismatch: ' + name)
            assets['vendor/pyodide/runtime/' + name] = data
    return assets


def install(assets, root=ROOT):
    """Install a fully verified asset set; shared by packaging and the local launcher."""
    for name, data in assets.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + '.tmp')
        temporary.write_bytes(data)
        temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--shrinko-archive', help='Use the pinned .tar.gz from disk instead of downloading')
    parser.add_argument('--pyodide-archive', help='Use the pinned .tgz from disk instead of downloading')
    args = parser.parse_args()
    lock = json.loads((ROOT / 'vendor/minifier-lock.json').read_text())
    assets = prepare(lock, archive_bytes(lock['shrinko8'], args.shrinko_archive),
                     archive_bytes(lock['pyodide'], args.pyodide_archive))
    install(assets)
    print(f"Installed {len(assets)} verified assets ({sum(map(len, assets.values())):,} bytes).")


if __name__ == '__main__':
    main()
