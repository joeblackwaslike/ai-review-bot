import collections
import threading


class EventQueue:
    def __init__(self, max_size=1000):
        self._items = collections.deque()
        self._lock = threading.Lock()
        self.max_size = max_size

    def push(self, event):
        with self._lock:
            if len(self._items) >= self.max_size:
                self._items.popleft()
            self._items.append(event)

    def drain(self, limit=50):
        with self._lock:
            count = min(limit, len(self._items))
            return [self._items.popleft() for _ in range(count)]

    def __len__(self):
        return len(self._items)
