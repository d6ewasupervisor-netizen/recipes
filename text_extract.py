"""Parse unstructured recipe text (descriptions, transcripts, comments)."""

import re
from typing import Any

INGREDIENT_HEADER = re.compile(
    r"^(?:##\s*)?(?:ingredients?|what you(?:'ll| will) need|you will need)\s*:?\s*$",
    re.I,
)
INSTRUCTION_HEADER = re.compile(
    r"^(?:##\s*)?(?:instructions?|directions?|method|steps?|how to make)\s*:?\s*$",
    re.I,
)
QUANTITY_LINE = re.compile(
    r"^(\d+(?:\.\d+)?(?:\s*/\s*\d+)?|\d+\s+\d+/\d+)\s+"
    r"(cup|cups|tbsp|tablespoon|tsp|teaspoon|oz|ounce|lb|pound|g|gram|kg|ml|l|clove|cloves|block|blocks|pinch|can|cans)\b",
    re.I,
)
STEP_LINE = re.compile(r"^\d+[\.)]\s+")
MARKDOWN_BULLET = re.compile(r"^[*-]\s+")
MARKDOWN_STEP = re.compile(r"^\d+\.\s+")
COOKING_VERBS = re.compile(
    r"\b(preheat|smoke|grill|bake|roast|cook|simmer|boil|fry|sear|mix|stir|add|season|score|wrap|place|remove|serve|chop|mince|slice|combine|whisk|reduce|let|set)\b",
    re.I,
)
NOISE_TAGS = re.compile(r"\[(?:music|applause|laughter)\]", re.I)
JUNK_INGREDIENT = re.compile(
    r"\b(welcome|channel|today|sorry|beautiful|spain|wine|cava|cheers|amateur)\b|^(when|if|the|this|i'm|you|just)\b",
    re.I,
)
PRODUCT_SUFFIX = re.compile(
    r"\b(rub|seasoning|cheese|oil|sauce|jelly|jam|crackers|foil|spray|butter|flour|sugar|bacon|brisket|chuck)\b",
    re.I,
)
YOUTUBE_STEP_SPLIT = re.compile(
    r"(?<=[.!?])\s+(?=(?:first|next|then|now|okay|all right|let's|when|after|i'm gonna|we're gonna|you're gonna|i have|my smoker|it's been)\b)|"
    r"(?<=\.)\s+(?=First|Next|Then|Now|Okay|All right|Let's)",
    re.I,
)


def _clean_text(text: str) -> str:
    text = NOISE_TAGS.sub("", text)
    text = text.replace("\u2019", "'").replace("\u2018", "'")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _is_markdown_noise(line: str) -> bool:
    low = line.lower()
    if not line.strip():
        return True
    if line.startswith("!["):
        return True
    if line.startswith("[") and "](http" in line:
        return True
    if low.startswith("http://") or low.startswith("https://"):
        return True
    if "oops!" in low or "something went wrong" in low:
        return True
    if re.fullmatch(r"[0-9]+/[0-9]+x", low.replace(" ", "")):
        return True
    if low in {"1x", "2x", "1/2x", "next", "prev"}:
        return True
    if low.startswith("original recipe"):
        return True
    if low.startswith("dotdash meredith"):
        return True
    return False


def _looks_like_ingredient_line(line: str) -> bool:
    if _is_markdown_noise(line):
        return False
    if QUANTITY_LINE.match(line):
        return True
    return bool(
        re.match(r"^[\d½⅓⅔¼¾⅛⅜⅝⅞]", line)
        or re.match(r"^\d+\s*\(", line)
        or re.search(r"\b(salt|pepper|butter|flour|cup|cups|teaspoon|tablespoon|ounce|pound|can)\b", line, re.I)
    )


def _markdown_title(text: str) -> str | None:
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("# "):
            title = line[2:].strip()
            title = re.sub(r"\s+Recipe$", "", title, flags=re.I)
            return title or None
    return None


def parse_markdown_recipe(text: str) -> dict[str, Any] | None:
    structured = parse_structured_text(text)
    if structured:
        title = _markdown_title(text)
        if title:
            structured["title"] = title
        return structured
    return None


def parse_structured_text(text: str) -> dict[str, Any] | None:
    lines = [ln.strip() for ln in text.splitlines()]
    markdown_mode = any(line.startswith("## ") for line in lines)
    mode = None
    ingredients: list[str] = []
    instructions: list[str] = []

    for line in lines:
        if not line:
            continue
        if INGREDIENT_HEADER.match(line):
            mode = "ingredients"
            continue
        if INSTRUCTION_HEADER.match(line):
            mode = "instructions"
            continue
        if mode == "ingredients":
            bullet = MARKDOWN_BULLET.match(line)
            if bullet:
                line = line[bullet.end() :].strip()
            elif markdown_mode:
                if line.startswith("#"):
                    continue
                if not QUANTITY_LINE.match(line):
                    continue
            if markdown_mode and not _looks_like_ingredient_line(line):
                continue
            if _is_markdown_noise(line) or len(line) < 4:
                continue
            ingredients.append(line.lstrip("-•").strip())
        elif mode == "instructions":
            step = MARKDOWN_STEP.match(line)
            if step:
                line = line[step.end() :].strip()
            elif markdown_mode:
                continue
            else:
                line = STEP_LINE.sub("", line)
            if _is_markdown_noise(line) or len(line) < 8:
                continue
            instructions.append(line)

    if ingredients and instructions:
        return {"ingredient_lines": ingredients, "instruction_lines": instructions}
    return None


def _title_case_phrase(phrase: str) -> str:
    words = phrase.split()
    keep_lower = {"a", "an", "the", "and", "or", "of", "with", "on", "in", "for", "to"}
    out = []
    for i, w in enumerate(words):
        if i > 0 and w.lower() in keep_lower:
            out.append(w.lower())
        else:
            out.append(w[:1].upper() + w[1:] if w else w)
    return " ".join(out)


def _dedupe_phrases(phrases: list[str]) -> list[str]:
    out: list[str] = []
    for phrase in phrases:
        key = phrase.lower()
        if any(key in existing.lower() or existing.lower() in key for existing in out):
            continue
        out.append(phrase)
    return out


BAD_PRODUCT = re.compile(
    r"\b(i have a|um all|these up|gonna seasoning|like the seasoning|with the hay|kinds of stuff|on this stuff|let's do the|get all sides)\b",
    re.I,
)


def _clean_products(products: list[str]) -> list[str]:
    cleaned: list[str] = []
    for phrase in products:
        if BAD_PRODUCT.search(phrase):
            continue
        if len(phrase.split()) > 8:
            continue
        cleaned.append(phrase)
    return _dedupe_phrases(cleaned)


def _extract_named_products(text: str) -> list[str]:
    lower = text.lower()
    products: list[str] = []

    named = [
        (r"hey grill hey sweet (?:barbecue )?rub", "Hey Grill Hey Sweet BBQ Rub"),
        (r"hay grill hay sweet (?:barbecue )?rub", "Hey Grill Hey Sweet BBQ Rub"),
        (r"killer hogs(?:'?s heart)? hot (?:barbecue )?rub", "Killer Hogs Hot BBQ Rub"),
    ]
    for pat, label in named:
        if re.search(pat, lower) and not any(label.lower() in p.lower() for p in products):
            products.append(label)

    for m in re.finditer(
        r"\b([a-z][a-z\s']{2,28}?(?:rub|seasoning|barbecue rub|bbq rub))\b",
        lower,
    ):
        phrase = re.sub(r"\s+", " ", m.group(1)).strip(" ,.")
        if JUNK_INGREDIENT.search(phrase) or BAD_PRODUCT.search(phrase) or len(phrase) < 6:
            continue
        products.append(_title_case_phrase(phrase))

    products = _clean_products(products)

    staples: list[tuple[str, str]] = [
        (r"\bcream cheese\b", "2 blocks cream cheese"),
        (r"\bnonstick spray\b", "Nonstick spray"),
        (r"\bolive oil\b", "Olive oil (optional)"),
        (r"\b(?:mango peach pepper jelly|pepper jelly)\b", "Mango peach pepper jelly (optional)"),
        (r"\bcrackers?\b", "Crackers, for serving"),
        (r"\bfoil\b", "Aluminum foil"),
    ]
    for pat, label in staples:
        if re.search(pat, lower) and not any(label.lower() in p.lower() for p in products):
            products.insert(0, label)

    return products[:10]


def _extract_ingredient_mentions(text: str) -> list[str]:
    found: list[str] = []
    for m in re.finditer(
        r"(\d+\s*(?:blocks?|cups?|tbsp|tsp|oz|lbs?|pounds?|cloves?)\s+(?:of\s+)?[^,.;]{3,50})",
        text,
        re.I,
    ):
        line = m.group(1).strip()
        if len(line) >= 4 and not JUNK_INGREDIENT.search(line):
            found.append(_title_case_phrase(line))
    return found[:12]


def _segment_transcript_steps(text: str) -> list[str]:
    # Auto-captions often lack periods — fall back to discourse markers.
    if len(re.findall(r"[.!?]", text)) < 4:
        parts = re.split(
            r"\b(?=(?:first,?|okay,?|all right,?|let's|now,?|then,?|when|after|my smoker|it's been|i'm gonna|we're gonna)\b)",
            text,
            flags=re.I,
        )
        chunks = [p.strip() for p in parts if p.strip() and len(p.strip()) > 30]
    else:
        chunks = []

    sentences = re.split(r"(?<=[.!?])\s+", text) if not chunks else []
    steps: list[str] = []
    buffer = ""

    for sentence in (chunks or sentences):
        sentence = sentence.strip()
        if not sentence or len(sentence) < 20:
            continue
        if JUNK_INGREDIENT.search(sentence) and not COOKING_VERBS.search(sentence):
            continue

        if COOKING_VERBS.search(sentence):
            if buffer:
                steps.append(buffer.strip())
            buffer = sentence
        elif buffer and len(buffer) + len(sentence) < 280:
            buffer = f"{buffer} {sentence}"
        elif buffer:
            steps.append(buffer.strip())
            buffer = ""

    if buffer:
        steps.append(buffer.strip())

    cleaned = []
    for step in steps:
        if step and step[-1] not in ".!?":
            step += "."
        if step:
            cleaned.append(step[0].upper() + step[1:])
    return cleaned[:12]


def _drop_intro_step(steps: list[str]) -> list[str]:
    cleaned: list[str] = []
    for step in steps:
        low = step.lower()
        if any(x in low[:120] for x in ("welcome to my channel", "thank you for tuning", "great appetizer party snack")):
            continue
        cleaned.append(step)
    return cleaned


def parse_transcript(text: str, title: str = "") -> dict[str, Any] | None:
    text = _clean_text(text)
    if len(text) < 80:
        return None

    structured = parse_structured_text(text)
    if structured:
        return structured

    ingredients = _extract_named_products(text)
    if not ingredients:
        ingredients = _extract_ingredient_mentions(text)
    steps = _drop_intro_step(_segment_transcript_steps(text))

    if len(steps) < 2:
        sentences = re.split(r"(?<=[.!?])\s+", text)
        steps = [
            s.strip()
            for s in sentences
            if len(s) > 40 and COOKING_VERBS.search(s) and not JUNK_INGREDIENT.search(s[:30])
        ][:10]
        steps = _drop_intro_step(steps)

    if not steps:
        return None
    if not ingredients:
        ingredients = ["Ingredients mentioned in video — review steps for amounts"]

    return {"ingredient_lines": ingredients, "instruction_lines": steps}


def parse_description_or_comment(text: str) -> dict[str, Any] | None:
    text = text.strip()
    if not text:
        return None
    structured = parse_structured_text(text)
    if structured:
        return structured

    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    ingredients = [ln.lstrip("-•* ").strip() for ln in lines if QUANTITY_LINE.match(ln.lstrip("-•* "))]
    if len(ingredients) >= 2:
        other = [ln for ln in lines if ln not in ingredients and len(ln) > 20]
        if other:
            return {"ingredient_lines": ingredients, "instruction_lines": other[:15]}
    return None
