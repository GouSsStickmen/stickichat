import io, os, re

src = io.open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src/renderer/src/lib/themes.ts'), encoding='utf-8').read()

def lin(c):
    c = c / 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

def lum(hexs):
    h = hexs.lstrip('#')
    if len(h) == 3: h = ''.join(x*2 for x in h)
    r, g, b = int(h[0:2],16), int(h[2:4],16), int(h[4:6],16)
    return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b)

def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)

# crude parse: each `id: 'x'` block followed by token literals
themes = {}
for m in re.finditer(r"id: '([a-z]+)',\s*\n\s*name: '([^']+)',\s*\n\s*dark: (true|false),\s*\n\s*tokens: \{(.*?)\n    \}", src, re.S):
    tid, name, dark, body = m.groups()
    toks = dict(re.findall(r"'(--[a-z0-9-]+)': '(#[0-9a-fA-F]{6})'", body))
    themes[tid] = (name, dark == 'true', toks)
# the dark theme is the DARK const
darkbody = re.search(r"const DARK: Record<string, string> = \{(.*?)\n\}", src, re.S).group(1)
themes = {'dark': ('Dark', True, dict(re.findall(r"'(--[a-z0-9-]+)': '(#[0-9a-fA-F]{6})'", darkbody)))} | themes

base = themes['dark'][2]
pairs = [('--text','--bg'), ('--text','--surface'), ('--text-muted','--bg'),
         ('--text-faint','--bg'), ('--link','--bg'), ('--accent','--bg'),
         ('--surface','--bg'), ('--surface-2','--surface'), ('--border','--surface')]

print(f"{'theme':10}" + ''.join(f"{a.replace('--','')[:6]}/{b.replace('--','')[:4]:<5}" for a,b in pairs))
for tid, (name, dark, toks) in themes.items():
    full = {**base, **toks}
    row = f'{name.encode("ascii","replace").decode():10}'
    for a, b in pairs:
        row += f'{ratio(full[a], full[b]):<12.2f}'
    print(row)
