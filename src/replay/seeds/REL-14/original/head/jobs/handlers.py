class PayloadHandler:
    name = "payload"

    @staticmethod
    def normalize_payload(payload, strict=False):
        cleaned = {}
        for key, value in payload.items():
            name = key.strip().lower()
            if isinstance(value, str):
                value = value.strip()
            if value in (None, ""):
                if strict:
                    raise ValueError("empty value for " + name)
                continue
            cleaned[name] = value
        return cleaned
