"""Turn real Kleinanzeigen alert emails into the sanitized fixtures in src/testing/fixtures.

Usage: python3 -I scripts/sanitize.py <source dir with N.eml and N.html> <fixtures out dir> <originals list out>

The source emails and the originals list hold real identifiers, so keep both outside the repo. The
originals list exists so the repo can be searched for every value the script replaced.
"""

import re
import sys

SRC, OUT, ORIGINALS = sys.argv[1], sys.argv[2], sys.argv[3]

PLAN = [
    # source, fixture, n, invented title, invented price
    ("3", "alert-gpu-negotiable.eml", 1, "Gigabyte RTX 4090 Gaming OC 24GB mit Rechnung", "2.450 € VB"),
    ("2", "alert-gpu-5090.eml", 2, "Palit RTX 5090 GameRock 32GB OVP mit Zubehör", "11.200 € VB"),
    ("4", "alert-pc-fixed.eml", 3, "Gaming PC Ryzen 7 5800X3D mit RTX 3090 24GB und 32GB RAM", "1.850 €"),
    ("5", "alert-gpu-fixed.eml", 4, "Zotac RTX 4090 Trinity OC 24GB mit Wasserkühler", "2.380 €"),
    ("6", "alert-ram-business.eml", 5, "Kingston Fury Beast DDR5 32 GB 5600MHz Kit", "320 €"),
    ("1", "activation.eml", 6, None, None),
]

BOUNCE = "bounces+0000000-0000-mailbox=example.invalid@em4286.kleinanzeigen.de"
MAILBOX = "mailbox@example.invalid"
DROP = re.compile(r"^(X-SG-|X-Entity-ID$|X-Spam|X-Rspamd-)", re.I)

ACTIVATION_HTML = (
    "<!DOCTYPE html>\r\n"
    "<html>\r\n"
    "<head>\r\n"
    '  <meta charset="utf-8">\r\n'
    "  <title>Kleinanzeigen</title>\r\n"
    "</head>\r\n"
    "<body>\r\n"
    "  <p>Hallo,</p>\r\n"
    "  <p>bitte bestätige deine E-Mail-Adresse, damit wir dein Konto bei Kleinanzeigen aktivieren können.</p>\r\n"
    "  <p>Der Aktivierungslink ist in dieser Testdatei entfernt.</p>\r\n"
    "</body>\r\n"
    "</html>\r\n"
)

originals = set()
saved_search_map = {}


def mask(value):
    """Same length and character class: digits to 0, letters to A or a, the rest kept."""
    out = []
    for ch in value:
        if ch.isdigit():
            out.append("0")
        elif "A" <= ch <= "Z":
            out.append("A")
        elif "a" <= ch <= "z":
            out.append("a")
        else:
            out.append(ch)
    return "".join(out)


def mask_match(group):
    def repl(m):
        start, end = m.span(group) if isinstance(group, int) else m.span(group)
        originals.update(t for t in re.split(r"\s+", m.group(group)) if len(t) >= 6)
        whole_start = m.start(0)
        text = m.group(0)
        return text[: start - whole_start] + mask(m.group(group)) + text[end - whole_start :]

    return repl


def qp_decode(body):
    return re.sub(
        rb"=(\r\n|[0-9A-Fa-f]{2})",
        lambda m: b"" if m.group(1) == b"\r\n" else bytes([int(m.group(1), 16)]),
        body,
    )


def qp_encode(data, per_line=75):
    """Quoted-printable the way the sender's encoder (JavaMail) does it: 76 chars a line."""
    out = bytearray()
    lines = data.split(b"\r\n")
    for index, line in enumerate(lines):
        count = 0
        for pos, byte in enumerate(line):
            trailing_space = byte in (0x20, 0x09) and pos == len(line) - 1
            encode = byte < 0x20 and byte != 0x09 or byte > 0x7E or byte == 0x3D or trailing_space
            width = 3 if encode else 1
            if count + width > per_line:
                out += b"=\r\n"
                count = 0
            out += b"=%02X" % byte if encode else bytes([byte])
            count += width
        if index < len(lines) - 1:
            out += b"\r\n"
    return bytes(out)


def split_fields(block):
    fields = []
    for line in block.split("\r\n"):
        if line[:1] in (" ", "\t") and fields:
            fields[-1] += "\r\n" + line
        else:
            fields.append(line)
    return fields


def sanitize_headers(block, n):
    out = []
    for field in split_fields(block):
        name = field.split(":", 1)[0]
        if DROP.match(name):
            continue
        lower = name.lower()
        for token in re.findall(r"bounces\+[^@>\s]+", field):
            originals.add(token)
        field = re.sub(r"bounces\+[^@>\s]+@em4286\.kleinanzeigen\.de", BOUNCE, field)
        field = re.sub(r"for <[^>]+>", f"for <{MAILBOX}>", field)
        for pod in re.findall(r"(?:saved-search-application|desktop|recvd)-[0-9a-f]+-[0-9a-z]+", field):
            originals.add(pod)
        field = re.sub(r"saved-search-application-[0-9a-f]+-[0-9a-z]+", "saved-search-application-fixture", field)
        field = re.sub(r"desktop-[0-9a-f]+-[0-9a-z]+", "desktop-fixture", field)
        field = re.sub(r"recvd-[0-9a-f]+-[0-9a-z]+", "recvd-fixture", field)
        if lower == "delivered-to":
            originals.add(field.split(":", 1)[1].strip())
            field = f"Delivered-To: {MAILBOX}"
        elif lower == "to":
            field = f"To: {MAILBOX}"
        elif lower == "message-id":
            original = field.split(":", 1)[1].strip()
            originals.add(original)
            originals.add(original.strip("<>").split("@")[0])
            field = f"Message-ID: <10000000{n:02d}.1.1792580000000@saved-search-application-fixture>"
        elif lower == "received":
            field = re.sub(r"(\bid\s+(?:recvd-fixture-)?)(?P<id>[^\s;()]+)", mask_match("id"), field)
        elif lower == "authentication-results":
            field = re.sub(r"header\.b=(?P<b>[^;\s]+)", mask_match("b"), field)
        elif lower == "dkim-signature":
            field = re.sub(r"\bbh=(?P<bh>[^;]+)", mask_match("bh"), field)
            field = re.sub(r";\s*b=(?P<b>[^;]+)$", mask_match("b"), field)
        out.append(field)
    return "\r\n".join(out)


def replace_once(html, old, new, expected):
    found = html.count(old)
    if found != expected:
        raise SystemExit(f"expected {expected} of a value, found {found}")
    originals.add(old)
    return html.replace(old, new)


def sanitize_alert_html(html, n, title, price):
    saved_ids = set(re.findall(r"m-suche-verwenden\.html\?id=(\d+)", html))
    ad_ids = re.findall(r"/s-anzeige/(\d+)\?sa=(\d+)", html)
    images = re.findall(r"/prod-ads/images/([0-9a-f]{2})/([0-9a-f-]{36})", html)
    upns = re.findall(r"upn=([^\"&]+)", html)
    titles = re.findall(r'alt="Bild zur Anzeige ([^"]+)"', html)
    prices = re.findall(r'<span style="font-weight:700">([^<]+)</span>', html)
    assert len(saved_ids) == 1 and len(ad_ids) == 1 and len(images) == 1, (saved_ids, ad_ids, images)
    assert len(upns) == 1 and len(titles) == 1 and len(prices) == 1, (upns, titles, prices)
    (saved_id,) = saved_ids
    assert ad_ids[0][1] == saved_id
    fake_saved = saved_search_map.setdefault(saved_id, f"9000000{len(saved_search_map) + 1:02d}")
    html = replace_once(html, f"?id={saved_id}&", f"?id={fake_saved}&", 1)
    html = replace_once(html, f"?sa={saved_id}&", f"?sa={fake_saved}&", 1)
    html = replace_once(html, f"/s-anzeige/{ad_ids[0][0]}?", f"/s-anzeige/90000000{n:02d}?", 1)
    folder, uuid = images[0]
    html = replace_once(html, f"/images/{folder}/{uuid}?", f"/images/00/00000000-0000-4000-8000-0000000000{n:02d}?", 1)
    originals.add(uuid)
    html = replace_once(html, f"upn={upns[0]}", "upn=FIXTURE", 1)
    html = replace_once(html, titles[0], title, 2)
    html = replace_once(html, f">{prices[0]}</span>", f">{price}</span>", 1)
    originals.add(saved_id)
    originals.add(ad_ids[0][0])
    return html


def main():
    for source, fixture, n, title, price in PLAN:
        raw = open(f"{SRC}/{source}.eml", "rb").read()
        head, body = raw.split(b"\r\n\r\n", 1)
        if qp_encode(qp_decode(body)) != body:
            raise SystemExit(f"{source}.eml: quoted-printable round trip differs")
        headers = sanitize_headers(head.decode("ascii"), n)
        if title is None:
            originals.update(re.findall(r"uuid=([0-9a-f-]{36})", qp_decode(body).decode("utf-8")))
            html = ACTIVATION_HTML
        else:
            decoded = qp_decode(body)
            if decoded != open(f"{SRC}/{source}.html", "rb").read():
                raise SystemExit(f"{source}.eml: decoded body differs from {source}.html")
            html = sanitize_alert_html(decoded.decode("utf-8"), n, title, price)
        out = headers.encode("ascii") + b"\r\n\r\n" + qp_encode(html.encode("utf-8"))
        with open(f"{OUT}/{fixture}", "wb") as handle:
            handle.write(out)
        print(f"{source}.eml -> {fixture} ({len(out)} bytes)")
    with open(ORIGINALS, "w", encoding="utf-8") as handle:
        handle.write("\n".join(sorted(originals)) + "\n")
    print(f"{len(originals)} original values written to the originals list")


main()
