from pathlib import Path
text = Path('app/page.tsx').read_text(encoding='utf-8')
idx = text.index('context: ')
print(repr(text[idx:idx+20]))
print(list(map(ord, text[idx:idx+20])))
