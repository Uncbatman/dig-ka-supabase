import re
import json
import sys

def parse_message(message):
    words = message.lower().split()
    
    items = []
    i = 0

    while i < len(words):
        word = words[i]

        # Check if next token is a number
        if i + 1 < len(words) and words[i + 1].isdigit():
            qty = int(words[i + 1])
            items.append({"name": word, "qty": qty})
            i += 2
        else:
            # Default qty = 1
            items.append({"name": word, "qty": 1})
            i += 1

    return {
        "agent": "order",
        "action": "create_order",
        "data": {
            "items": items
        }
    }


if __name__ == "__main__":
    message = sys.argv[1]
    result = parse_message(message)
    print(json.dumps(result))
