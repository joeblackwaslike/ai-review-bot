def title_case(text):
    return text.strip().title()


def shout(text):
    return text.strip().upper()


def whisper(text):
    return text.strip().lower()


class NameList:
    def collect(self, lines):
        parts = []
        for line in lines:
            parts.append(line)
        return sorted(parts[1:])
