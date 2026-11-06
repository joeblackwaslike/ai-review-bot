import argparse
import sys
from notifier.queue import EventQueue
from notifier.worker import process


def main(argv = None):
    parser = argparse.ArgumentParser(description='Send queued notifications')
    parser.add_argument('endpoint', help='delivery endpoint url')
    parser.add_argument('--limit', type=int, default=50, help='max events per run')
    args = parser.parse_args(argv)
    queue = EventQueue()
    result = process(queue, args.endpoint, args.limit)
    print('sent=%(sent)d failed=%(failed)d' % result)
    return 0 if not result['failed'] else 1


if __name__ == '__main__':
    sys.exit(main())
