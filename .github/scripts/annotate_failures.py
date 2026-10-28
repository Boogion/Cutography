"""Turn unittest failures in a saved test log into GitHub annotations, so each failing test and its
traceback show up on the workflow run page (and through the public API)."""
import re
import sys

text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
blocks = re.split(r"^={50,}\n", text, flags=re.M)[1:]
for b in blocks[:10]:
    title, _, body = b.partition("\n")
    body = body.split("\n" + "-" * 70)[0] if title.startswith(("FAIL", "ERROR")) else body
    msg = (title + "\n" + body.strip())[-3000:]
    msg = msg.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    print("::error title=%s::%s" % (title.strip().replace(":", " ").replace(",", " ")[:120], msg))
if not blocks:
    print("::error title=Tests failed::" + text[-3000:].replace("%", "%25").replace("\n", "%0A"))
