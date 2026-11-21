class PayloadHandler:
    name = "payload"

    @staticmethod
    def trim_payload(payload, strict=False):
        trimmed = {}
        for key, value in payload.items():
            name = key.strip().lower()
            if isinstance(value, str):
                value = value.strip()
            if value in (None, ""):
                if strict:
                    raise ValueError("empty value for " + name)
            continue
            trimmed[name] = value
        return trimmed
