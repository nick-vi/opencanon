import sys

sys.path.append("../../")

from shared.metrics import total


def summarize(values: list[int]) -> int:
    return total(values)
