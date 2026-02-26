from pathlib import Path
path = Path('app/page.tsx')
text = path.read_text(encoding='utf-8')
text2 = text.replace('context:  - ,', 'context: ,').replace('solutions:  - ,', 'solutions: ,')
print('changed', text != text2)
if text != text2:
    path.write_text(text2, encoding='utf-8')
    print('wrote change')
else:
    print('no writes needed')
