"""Generate the StickiChat design-system kit from the app's own tokens.

Nothing here is hand-authored colour: the theme palettes are parsed out of lib/themes.ts and
the shape/type scales out of global.css, so a preview can never drift from what ships.
"""
import io, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'design')

# ---------------------------------------------------------------- parse the app's real tokens
src = io.open(os.path.join(ROOT, 'src/renderer/src/lib/themes.ts'), encoding='utf-8').read()
tok_re = r"'(--[a-z0-9-]+)': '([^']+)'"

dark_body = re.search(r"const DARK: Record<string, string> = \{(.*?)\n\}", src, re.S).group(1)
DARK = dict(re.findall(tok_re, dark_body))

THEMES = [('dark', 'Dark', True, DARK)]
for m in re.finditer(
    r"id: '([a-z]+)',\s*\n\s*name: '([^']+)',\s*\n\s*dark: (true|false),\s*\n\s*tokens: \{(.*?)\n    \}",
    src, re.S
):
    tid, name, dark, body = m.groups()
    THEMES.append((tid, name, dark == 'true', {**DARK, **dict(re.findall(tok_re, body))}))

css = io.open(os.path.join(ROOT, 'src/renderer/src/styles/global.css'), encoding='utf-8').read()
root_block = re.search(r":root \{\n(.*?)\n\}", css, re.S).group(1)
SHAPE = dict(re.findall(r"\s*(--(?:radius|space|fs|dur|ease)[a-z0-9-]*):\s*([^;]+);", root_block))

# ---------------------------------------------------------------- the shared stylesheet
theme_classes = '\n'.join(
    '.t-%s {\n%s\n}' % (tid, '\n'.join(f'  {k}: {v};' for k, v in toks.items()))
    for tid, _, _, toks in THEMES
)
shape_vars = '\n'.join(f'  {k}: {v};' for k, v in SHAPE.items())

BASE = f""":root {{
{shape_vars}
  --font: 'Segoe UI', 'Inter', system-ui, -apple-system, sans-serif;
}}

/* Every theme, generated from src/renderer/src/lib/themes.ts. Do not hand-edit. */
{theme_classes}

* {{ box-sizing: border-box; }}
body {{
  margin: 0;
  font-family: var(--font);
  background: #101013;
  color: #efeff1;
  font-size: var(--fs-lg);
  padding: 24px;
}}
h1 {{ font-size: 20px; margin: 0 0 4px; font-weight: 650; }}
h1 + p {{ margin: 0 0 20px; color: #9a9aa4; font-size: var(--fs-md); max-width: 70ch; line-height: 1.5; }}
h2 {{ font-size: var(--fs-md); margin: 0 0 8px; color: #9a9aa4; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em; }}

/* every component is shown once per theme, side by side: a token that only works on the
   theme you happened to be using is the single most common way this UI has broken */
.themes {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }}
.panel {{
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: var(--space-4);
  overflow: hidden;
}}
.panel > .label {{
  font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--text-faint); margin-bottom: var(--space-3);
}}
.row {{ display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }}
.stack {{ display: flex; flex-direction: column; gap: var(--space-3); }}

/* --- app controls, mirrored from global.css --- */
.btn {{
  font-family: inherit; font-size: var(--fs-md);
  background: var(--surface-2); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 5px 10px; cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}}
.btn:hover {{ background: var(--border); }}
.btn.primary {{ background: var(--accent-strong); color: var(--accent-text); border-color: transparent; }}
.btn.danger {{ background: var(--danger); color: var(--accent-text); border-color: transparent; }}
.btn.ghost {{ background: transparent; color: var(--text-muted); }}
.btn:disabled {{ opacity: 0.45; cursor: not-allowed; }}
.field {{
  font-family: inherit; font-size: var(--fs-md);
  background: var(--surface-2); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 6px 9px; outline: none; width: 100%;
}}
.field.focused {{ border-color: var(--accent); }}
.chip {{
  display: inline-flex; align-items: center; gap: var(--space-0);
  background: var(--surface-3); border: 1px solid var(--border);
  border-radius: var(--radius-pill); padding: 2px 10px; font-size: var(--fs-md);
}}
.chip.active {{ background: var(--accent-strong); color: var(--accent-text); border-color: transparent; }}
.tab {{
  display: inline-flex; align-items: center; gap: var(--space-2);
  background: var(--surface); border: 1px solid var(--border); border-bottom: none;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  padding: 5px 10px; font-size: var(--fs-lg); color: var(--text-muted);
}}
.tab.active {{ background: var(--surface-3); color: var(--text); }}
.dot {{ width: 8px; height: 8px; border-radius: var(--radius-circle); background: var(--live); }}
.msg {{ padding: 3px 10px; line-height: 1.5; font-size: var(--fs-lg); }}
.msg.alt {{ background: var(--surface-2); }}
.msg.mention {{ background: var(--highlight-bg); box-shadow: inset 2px 0 0 var(--accent); }}
.nick {{ font-weight: 700; }}
.ts {{ color: var(--text-faint); font-size: var(--fs-sm); margin-right: var(--space-2);
       font-variant-numeric: tabular-nums; }}
.sys {{ color: var(--system-text); font-size: var(--fs-md); }}
.badge {{ display: inline-block; width: 18px; height: 18px; border-radius: var(--radius-xs);
          background: var(--accent-strong); margin-right: 3px; vertical-align: -3px; }}
a {{ color: var(--link); }}
"""


def page(title, blurb, group, subtitle, body_for_theme, themes=None, width=1180, height=760):
    """One preview file: the same markup rendered once per theme."""
    picked = [t for t in THEMES if themes is None or t[0] in themes]
    panels = '\n'.join(
        f'      <div class="panel t-{tid}">\n'
        f'        <div class="label">{name}</div>\n{body_for_theme(tid, name, dark, toks)}\n'
        f'      </div>'
        for tid, name, dark, toks in picked
    )
    slug = group.lower().replace(' ', '-')
    html = f"""<!-- @dsCard group="{group}" name="{title}" subtitle="{subtitle}" width="{width}" height="{height}" -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>StickiChat — {title}</title>
<style>
{BASE}
</style>
</head>
<body>
<h1>{title}</h1>
<p>{blurb}</p>
<div class="themes">
{panels}
</div>
</body>
</html>
"""
    os.makedirs(os.path.join(OUT, slug), exist_ok=True)
    path = os.path.join(OUT, slug, title.lower().replace(' ', '-').replace('&', 'and') + '.html')
    io.open(path, 'w', encoding='utf-8', newline='\n').write(html)
    return os.path.relpath(path, ROOT).replace('\\', '/')


written = []

# ---------------------------------------------------------------- foundations
def colours(tid, name, dark, toks):
    keys = ['--bg', '--surface', '--surface-2', '--surface-3', '--border', '--text',
            '--text-muted', '--text-faint', '--accent', '--accent-strong', '--link',
            '--danger', '--success', '--warning', '--live']
    sw = '\n'.join(
        f'          <div style="display:flex;align-items:center;gap:8px;font-size:var(--fs-sm)">'
        f'<i style="width:22px;height:22px;border-radius:var(--radius-sm);flex:none;'
        f'background:{toks[k]};border:1px solid var(--border)"></i>'
        f'<span style="color:var(--text-muted)">{k[2:]}</span></div>'
        for k in keys
    )
    return f'        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">\n{sw}\n        </div>'

written.append(page(
    'Colour', 'Every palette side by side. A theme is a bag of token values in '
    '<code>lib/themes.ts</code> — nothing here is a CSS rule, which is why a user-made theme '
    'can reach the whole UI.', 'Foundations', 'All 7 themes, 15 tokens each', colours))


def typography(tid, name, dark, toks):
    rows = [('--fs-2xs', 'badge counters'), ('--fs-xs', 'dense labels'), ('--fs-sm', 'timestamps'),
            ('--fs-md', 'controls'), ('--fs-lg', 'chat body'), ('--fs-xl', 'stream info'),
            ('--fs-2xl', 'section heads')]
    return '\n'.join(
        f'        <div style="display:flex;justify-content:space-between;align-items:baseline;'
        f'gap:12px;padding:3px 0"><span style="font-size:var({k})">Швидка коричнева лисиця</span>'
        f'<span style="color:var(--text-faint);font-size:var(--fs-2xs);white-space:nowrap">'
        f'{k[2:]} · {use}</span></div>' for k, use in rows)

written.append(page(
    'Type scale', 'Seven sizes cover 97 of the ~101 <code>font-size</code> declarations in the '
    'app. <code>--font-size</code> is separate: it is the user\'s own chat size and is set at '
    'runtime.', 'Foundations', '7 steps, 9–15px', typography, themes=['dark', 'light']))


def shape(tid, name, dark, toks):
    rad = ''.join(
        f'<div style="text-align:center"><div style="width:52px;height:38px;background:var(--surface-3);'
        f'border:1px solid var(--border);border-radius:var(--radius-{r})"></div>'
        f'<div style="font-size:var(--fs-2xs);color:var(--text-faint);margin-top:4px">{r}</div></div>'
        for r in ['xs', 'sm', 'md', 'lg', 'xl', '2xl', 'pill'])
    sp = ''.join(
        f'<div style="text-align:center"><div style="width:var(--space-{s});height:26px;'
        f'background:var(--accent)"></div>'
        f'<div style="font-size:var(--fs-2xs);color:var(--text-faint);margin-top:4px">{s}</div></div>'
        for s in range(7))
    elev = ''.join(
        f'<div style="flex:1;min-width:74px;height:46px;background:var(--surface);'
        f'border-radius:var(--radius-lg);box-shadow:var(--{e});display:flex;align-items:center;'
        f'justify-content:center;font-size:var(--fs-2xs);color:var(--text-faint)">{e[2:]}</div>'
        for e in ['shadow-sm', 'shadow-md', 'shadow', 'shadow-lg'])
    return (f'        <div class="stack">\n'
            f'          <div><h2 style="color:var(--text-faint)">Radius</h2><div class="row">{rad}</div></div>\n'
            f'          <div><h2 style="color:var(--text-faint)">Space</h2>'
            f'<div class="row" style="align-items:flex-end">{sp}</div></div>\n'
            f'          <div><h2 style="color:var(--text-faint)">Elevation</h2>'
            f'<div class="row">{elev}</div></div>\n        </div>')

written.append(page(
    'Shape & elevation', 'The app used to hold twelve different <code>border-radius</code> values '
    'and no spacing or elevation tokens at all — controls sitting side by side were never the '
    'same family. Shadows are per-theme so a light theme stops wearing dark-theme shadows.',
    'Foundations', 'Radius, spacing, elevation', shape, themes=['dark', 'light'], height=900))

# ---------------------------------------------------------------- components
def buttons(tid, name, dark, toks):
    return ('        <div class="stack">\n'
            '          <div class="row"><button class="btn primary">Зберегти</button>'
            '<button class="btn">Скасувати</button>'
            '<button class="btn ghost">Пропустити</button>'
            '<button class="btn danger">Видалити</button></div>\n'
            '          <div class="row"><button class="btn" disabled>Вимкнена</button>'
            '<button class="btn primary" disabled>Вимкнена</button></div>\n'
            '        </div>')

written.append(page(
    'Buttons', 'Four intents. <code>--accent-text</code> is the one token for text on any '
    'saturated fill, which is why a theme with a pale accent (Nord, Gruvbox) can flip it to a '
    'dark value in one place instead of forty.', 'Components', 'Primary, default, ghost, danger',
    buttons, height=620))


def forms(tid, name, dark, toks):
    return ('        <div class="stack">\n'
            '          <input class="field" value="gous_stickmen">\n'
            '          <input class="field focused" value="фокус — рамка бере акцент">\n'
            '          <div class="row"><span class="chip">Чат</span>'
            '<span class="chip active">Виділені</span>'
            '<span class="chip">Реворди</span></div>\n'
            '        </div>')

written.append(page(
    'Fields & chips', 'Inputs and the filter chips used for mod-button placement, overlay '
    'profiles and highlight tabs.', 'Components', 'Input, focus, chips', forms, height=620))


def tabs(tid, name, dark, toks):
    return ('        <div style="display:flex;gap:4px;align-items:flex-end">'
            '<span class="tab active"><i class="dot"></i>StreamDatabase</span>'
            '<span class="tab">moonosya</span>'
            '<span class="tab">skali_</span></div>')

written.append(page(
    'Tabs', 'Channel tabs. The live dot is <code>--live</code>, a token so a theme can tune it '
    'rather than the two literals it used to be.', 'Components', 'Active, idle, live dot',
    tabs, height=520))


def message(tid, name, dark, toks):
    return ('        <div style="margin:-8px -12px">\n'
            '          <div class="msg"><span class="ts">05:31</span>'
            '<i class="badge"></i><span class="nick" style="color:var(--link)">Bobik069</span>'
            ': привіт чат!</div>\n'
            '          <div class="msg alt"><span class="ts">05:31</span>'
            '<span class="nick" style="color:var(--success)">Mira_Cat</span>'
            ': дуже класний оверлей вийшов</div>\n'
            '          <div class="msg mention"><span class="ts">05:32</span>'
            '<i class="badge"></i><span class="nick" style="color:var(--warning)">n1cole_cat</span>'
            ': <b>@gous_stickmen</b> глянь сюди</div>\n'
            '          <div class="msg"><span class="sys">@Bobik069 має тайм-аут 10 хв</span></div>\n'
            '          <div class="msg"><span class="ts">05:33</span>'
            '<span class="nick" style="color:var(--danger)">Pinuses</span>'
            ': <a href="#">streamdatabase.com/events</a></div>\n'
            '        </div>')

written.append(page(
    'Chat message', 'The row everything else exists to support. Alternating rows use '
    '<code>--surface-2</code>, mentions use <code>--highlight-bg</code> plus an accent stripe, '
    'and system lines use <code>--system-text</code>.', 'Components',
    'Plain, alternating, mention, system, link', message, height=720))


def toast(tid, name, dark, toks):
    return ('        <div class="stack">\n'
            '          <div style="background:var(--surface);border:1px solid var(--border);'
            'border-radius:var(--radius-xl);box-shadow:var(--shadow-md);padding:10px 12px">\n'
            '            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'
            '<button class="btn ghost" style="padding:1px 7px;font-size:var(--fs-sm)">'
            'Більше не показувати</button>'
            '<button class="btn ghost" style="margin-left:auto;padding:1px 7px">✕</button></div>\n'
            '            <div style="font-size:var(--fs-md);color:var(--text-muted)">'
            'Не вдалося завантажити емоути каналу</div>\n'
            '          </div>\n'
            '          <div style="background:var(--danger);color:var(--accent-text);'
            'border-radius:var(--radius-xl);padding:10px 12px;font-size:var(--fs-md);'
            'display:flex;align-items:center;gap:10px">Сесія завершилась'
            '<button class="btn" style="margin-left:auto;background:var(--accent-text);'
            'color:var(--danger);border:none">Увійти</button></div>\n'
            '        </div>')

written.append(page(
    'Toasts & banners', 'Dismiss controls sit in a header row above the text, not inline with '
    'it. The re-auth banner is the one place a saturated fill covers a full-width strip.',
    'Components', 'Error toast, re-auth banner', toast, height=680))


def overlay_modal(tid, name, dark, toks):
    return ('        <div style="position:relative;height:150px;border-radius:var(--radius-lg);'
            'overflow:hidden;border:1px solid var(--border)">\n'
            '          <div style="position:absolute;inset:0;padding:6px 10px;font-size:var(--fs-sm);'
            'color:var(--text-muted)">чат під модалкою лишається читабельним</div>\n'
            '          <div style="position:absolute;inset:0;background:var(--scrim)"></div>\n'
            '          <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);'
            'background:var(--surface);border:1px solid var(--border);'
            'border-radius:var(--radius-2xl);box-shadow:var(--shadow-lg);padding:12px 16px;'
            'font-size:var(--fs-md)">Налаштування</div>\n'
            '        </div>')

written.append(page(
    'Scrim & modal', 'The scrim is per-theme. At a flat 55% black it read as fog on every palette '
    'that is not near-black — and since you only ever see a theme through the settings window '
    'while picking it, that made three themes look broken.', 'Components',
    'Modal over dimmed chat', overlay_modal, height=680))

print('\n'.join(written))
