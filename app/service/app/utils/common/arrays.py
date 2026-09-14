from typing import List, Optional


def lru_add(arrays: Optional[List[str]], tar: Optional[str], limit: int) -> List[str]:
    # if arrays is None, initialize as empty list
    if arrays is None:
        arrays = []

    if not tar:
        return arrays

    # if tar in arrays, move to first
    if tar in arrays:
        arrays.remove(tar)  # remove existing tar

    # if tar not in arrays, and exceeds limit, remove last element
    if len(arrays) >= limit:
        arrays.pop()  # remove last element to keep length limit

    # add tar to first
    arrays.insert(0, tar)

    # ensure arrays length not exceeds limit
    while len(arrays) > limit:
        arrays.pop()  # remove last element to keep length limit

    return arrays