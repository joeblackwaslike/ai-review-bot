import string

TEMPLATES = {
    "welcome": "Hello $name, welcome to $product",
    "reset": "Hi $name, use code $code to reset your password",
    "invoice": "Invoice $number for $amount is due on $due",
}


def render(name, **fields):
    template = string.Template(TEMPLATES[name])
    return template.substitute(**fields)


def known_templates():
    return sorted(TEMPLATES.keys())
