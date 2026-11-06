from dataclasses import dataclass, field


@dataclass
class LineItem:
    sku: str
    unit_cents: int
    quantity: int


@dataclass
class Invoice:
    number: str
    items: list[LineItem] = field(default_factory=list)
    tax_rate: float = 0.0
