"""Static (AST) safety pass — the first, fast line of defence.

It rejects shell / subprocess, raw network, and the classic dynamic-exec /
object-graph escape tricks BEFORE any code runs. Filesystem confinement — read
anywhere, write only the user's own output folder, never modify/delete anyone
else's files — is enforced by the Docker sandbox's read-only mounts in
`sandbox.py`, NOT here, so this pass intentionally does NOT block file
reads/writes/deletes (the user is allowed to manage their own folder).

This is deliberately NOT a complete sandbox (Python is far too dynamic to lock
down by static analysis alone) — the Docker container is the real boundary. Think
of this as cheap defence-in-depth that fails fast and explains why.
"""

import ast
from typing import List

# Whole modules that analysis code never legitimately needs and that are prime
# escape / exfiltration vectors.
_BANNED_IMPORTS = {
    "subprocess", "socket", "ctypes", "pty", "fcntl",
    "ftplib", "smtplib", "telnetlib", "http", "urllib", "requests",
    "multiprocessing", "_thread",
}

# Shell-out calls. (File delete/modify is intentionally NOT blocked — the Docker
# read-only mounts already stop the code touching anyone else's files, and the
# user is allowed to fully manage their own output folder.)
_BANNED_CALLS = {
    ("os", "system"), ("os", "popen"), ("os", "startfile"),
}
# any os.exec* / os.spawn* / os.fork*  → matched by prefix below
_BANNED_OS_PREFIXES = ("exec", "spawn", "fork", "kill")

# Bare names that enable dynamic execution / sandbox escape.
_BANNED_NAMES = {"eval", "exec", "compile", "__import__", "breakpoint", "input"}

# Attribute names used in the classic `().__class__.__bases__[0].__subclasses__()`
# escape chains and builtins tampering.
_BANNED_ATTRS = {
    "__subclasses__", "__bases__", "__mro__", "__globals__",
    "__builtins__", "__import__", "__loader__", "__code__",
}


class _Guard(ast.NodeVisitor):
    def __init__(self) -> None:
        self.violations: List[str] = []

    def _flag(self, node: ast.AST, msg: str) -> None:
        line = getattr(node, "lineno", "?")
        self.violations.append(f"line {line}: {msg}")

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            root = alias.name.split(".")[0]
            if root in _BANNED_IMPORTS:
                self._flag(node, f"import of '{alias.name}' is not allowed")
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        root = (node.module or "").split(".")[0]
        if root in _BANNED_IMPORTS:
            self._flag(node, f"import from '{node.module}' is not allowed")
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load) and node.id in _BANNED_NAMES:
            self._flag(node, f"use of '{node.id}' is not allowed")
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr in _BANNED_ATTRS:
            self._flag(node, f"access to '{node.attr}' is not allowed")
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func
        if isinstance(func, ast.Attribute):
            attr = func.attr
            mod = func.value.id if isinstance(func.value, ast.Name) else None
            if mod and (mod, attr) in _BANNED_CALLS:
                self._flag(node, f"call to {mod}.{attr}() is not allowed")
            elif mod == "os" and any(attr.startswith(p) for p in _BANNED_OS_PREFIXES):
                self._flag(node, f"call to os.{attr}() is not allowed")
        elif isinstance(func, ast.Name) and func.id in _BANNED_NAMES:
            self._flag(node, f"call to '{func.id}()' is not allowed")
        self.generic_visit(node)


def check(code: str) -> List[str]:
    """Return a list of human-readable violations (empty list ⇒ passes)."""
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"syntax error: {e}"]
    guard = _Guard()
    guard.visit(tree)
    return guard.violations
