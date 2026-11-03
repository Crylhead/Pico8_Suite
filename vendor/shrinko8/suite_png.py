"""Optional Suite PNG envelope around pinned Shrinko8 ROM serialization; stdlib only."""
import base64
import json
import struct
import zlib
from pico_cart import read_cart_from_source, write_cart_to_rom, read_cart_from_rom, k_cart_image_size, k_label_offset
from pico_defs import k_palette, k_cart_size, k_trailer_size, k_code_size
from pico_process import PicoContext, CartSource
from pico_tokenize import tokenize, count_tokens
from pico_parse import parse

# PICO-8 0.2.7 manual: compressed code must be LESS than 15,360 bytes.
# Shrinko8 additionally enforces its physical code region (k_code_size = 15,616).
COMPRESSED_BUDGET = 15360


def export_png(text):
    try:
        if not isinstance(text, str) or len(text) > 2_000_000 or not text.startswith('pico-8 cartridge'):
            raise ValueError('PNG needs a complete validated text cartridge, not Lua or binary input.')
        # Never follow includes or open project files while exporting a resolved build.
        cart = read_cart_from_source(text, preprocess_hook=lambda path, code, *args, **opts: (code, []))
        source, context = CartSource(cart), PicoContext()
        tokens, errors = tokenize(source, context)
        if not errors:
            _, errors = parse(source, tokens, context)
        if errors:
            raise ValueError('PNG requires complete valid Lua without unresolved includes or compiler directives.')
        if count_tokens(tokens) > 8192 or len(cart.code) > 65535:
            return json.dumps({'ok': False, 'diagnostics': [{'severity': 'error', 'code': 'E_PNG_CAPACITY', 'message': 'PNG blocked: code exceeds the 8,192-token or 65,535-character budget. Lua/text-cart exports remain available.'}]})
        measured = []
        rom = write_cart_to_rom(cart, with_trailer=True, force_compress=True, fail_on_error=False,
                                size_handler=lambda prefix, name, size, limit: measured.append(size))
        compressed = measured[-1]
        if compressed >= COMPRESSED_BUDGET or len(rom) != k_cart_size + k_trailer_size:
            return json.dumps({'ok': False, 'diagnostics': [{'severity': 'error', 'code': 'E_PNG_CAPACITY', 'message': f'PNG blocked: compressed code uses {compressed} bytes; published budget is less than {COMPRESSED_BUDGET}. Text exports remain available.'}]})
        check = read_cart_from_rom(rom)
        if check.code != cart.code or check.rom != cart.rom or check.version_id != cart.version_id:
            raise ValueError('PNG ROM verification failed; no image was generated.')
        width, height = k_cart_image_size
        pixels = bytearray()
        for y in range(height):
            pixels.append(0)  # PNG filter None; exact RGBA samples carry cartridge bytes.
            for x in range(width):
                color = (29, 43, 83, 255) if 8 <= x < width - 8 and 8 <= y < height - 8 else (0, 0, 0, 255)
                lx, ly = x - k_label_offset.x, y - k_label_offset.y
                if 0 <= lx < 128 and 0 <= ly < 128:
                    color = k_palette[cart.label[lx, ly] if cart.label is not None else 0]
                r, g, b, a = color
                byte = rom[x + y * width]
                pixels.extend(((r & 252) | ((byte >> 4) & 3), (g & 252) | ((byte >> 2) & 3),
                               (b & 252) | (byte & 3), (a & 252) | ((byte >> 6) & 3)))
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
        png += chunk(b'IDAT', zlib.compress(bytes(pixels), 9)) + chunk(b'IEND', b'')
        return json.dumps({'ok': True, 'base64': base64.b64encode(png).decode('ascii'), 'pngBytes': len(png),
                           'compressedBytes': compressed, 'compressedBudgetExclusive': COMPRESSED_BUDGET,
                           'codeRegionBytes': k_code_size, 'width': width, 'height': height})
    except Exception:
        return json.dumps({'ok': False, 'diagnostics': [{'severity': 'error', 'code': 'E_PNG_EXPORT', 'message': 'PNG could not be encoded or verified. Keep the validated .p8/.lua build and retry; no PNG was downloaded.'}]})
