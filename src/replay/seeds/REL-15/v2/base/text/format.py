def join_lines(lines):
    parts = []
    for line in lines:
        parts.append(line)
    return "\n".join(parts)


def title_case(text):
    return text.strip().title()


def shout(text):
    return text.strip().upper()


def whisper(text):
    return text.strip().lower()
