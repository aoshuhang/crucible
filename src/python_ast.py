"""Read Python source on stdin and emit conservative, parse-checked mutations.

Executed with ``python3 -I`` by python-mutate.js. It never imports or executes
the source being inspected. AST coordinates are UTF-8 byte offsets; tokenize
coordinates and JavaScript string offsets are character based, so all slicing
goes through the conversion helpers below.
"""

import ast
import io
import json
import math
import sys
import token
import tokenize


BRACKETS = {"(": ")", "[": "]", "{": "}"}
COMPARISONS = (
    (ast.GtE, (">=", ">")),
    (ast.LtE, ("<=", "<")),
    (ast.Eq, ("==", "!=")),
    (ast.NotEq, ("!=", "==")),
    (ast.Gt, (">", ">=")),
    (ast.Lt, ("<", "<=")),
)
COMPARE_REPLACEMENTS = {op: pair for op, pair in COMPARISONS}


def is_plain_constant(node):
    """A literal-only right-hand side, including a signed numeric literal."""
    if isinstance(node, ast.Constant):
        return True
    return (
        isinstance(node, ast.UnaryOp)
        and isinstance(node.op, (ast.UAdd, ast.USub))
        and isinstance(node.operand, ast.Constant)
        and isinstance(node.operand.value, (int, float))
        and not isinstance(node.operand.value, bool)
    )


class PythonMutator(ast.NodeVisitor):
    """Collect independent, single-line mutations from a parsed module."""

    def __init__(self, source, profile):
        self.source = source
        self.lines = source.split("\n")
        self.strict = profile == "strict"
        self.tokens = []
        self.candidates = []
        self.seen = set()
        self.constant_declarations = set()
        self.docstrings = set()
        self.signed_numbers = set()
        self.tree = None

    def position(self, line, byte_column):
        """Convert an AST UTF-8 byte column to a Python string index."""
        raw = self.lines[line - 1].encode("utf-8")
        return len(raw[:byte_column].decode("utf-8"))

    def span(self, node):
        if (
            getattr(node, "lineno", None) is None
            or getattr(node, "end_lineno", None) is None
            or node.lineno != node.end_lineno
            or node.lineno < 1
            or node.lineno > len(self.lines)
        ):
            return None
        return (
            node.lineno,
            self.position(node.lineno, node.col_offset),
            self.position(node.end_lineno, node.end_col_offset),
        )

    def tokenize(self):
        depth = 0
        for item in tokenize.generate_tokens(io.StringIO(self.source).readline):
            if item.type == token.OP and item.string in BRACKETS.values():
                depth = max(0, depth - 1)
            self.tokens.append({
                "type": item.type,
                "string": item.string,
                "start": item.start,
                "end": item.end,
                "depth": depth,
            })
            if item.type == token.OP and item.string in BRACKETS:
                depth += 1

    def ancestors(self, node):
        parent = getattr(node, "parent", None)
        while parent is not None:
            yield parent
            parent = getattr(parent, "parent", None)

    def excluded(self, node):
        if id(node) in self.docstrings:
            return True
        if not self.strict and id(node) in self.constant_declarations:
            return True
        return any(
            isinstance(parent, (ast.Import, ast.ImportFrom))
            for parent in self.ancestors(node)
        )

    def emit(self, kind, span, replacement, description):
        if span is None:
            return
        line, start, end = span
        raw = self.lines[line - 1]
        original = raw[start:end]
        if not original or original == replacement:
            return

        mutated = raw[:start] + replacement + raw[end:]
        candidate_lines = list(self.lines)
        candidate_lines[line - 1] = mutated
        candidate = "\n".join(candidate_lines)
        try:
            ast.parse(candidate)
        except (SyntaxError, ValueError, TypeError, MemoryError, RecursionError):
            return

        key = (kind, line, start, end, replacement)
        if key in self.seen:
            return
        self.seen.add(key)
        self.candidates.append({
            "kind": kind,
            "line": line,
            "column": start + 1,
            "original": original,
            "mutated": mutated,
            "description": description,
        })

    def tokens_between(self, start, end, spelling=None):
        return [
            item for item in self.tokens
            if item["start"] >= start and item["end"] <= end
            and (spelling is None or item["string"] == spelling)
        ]

    def direct_tokens(self, node, spellings):
        """Operator tokens that belong to this node, not to a nested node."""
        span = self.span(node)
        if span is None:
            return []
        line, start_col, end_col = span
        start = (line, start_col)
        end = (line, end_col)
        inside = self.tokens_between(start, end)
        starting = [item for item in inside if item["start"] == start]
        if not starting:
            return []
        depth = starting[0]["depth"]
        return [
            item for item in inside
            if item["depth"] == depth and item["string"] in spellings
        ]

    def visit_Compare(self, node):
        span = self.span(node)
        if span is not None and not self.excluded(node):
            left = node.left
            for operator, right in zip(node.ops, node.comparators):
                replacement = COMPARE_REPLACEMENTS.get(type(operator))
                left_span = self.span(left)
                right_span = self.span(right)
                if (
                    replacement is not None
                    and left_span is not None
                    and right_span is not None
                ):
                    spelling, new_spelling = replacement
                    between = self.tokens_between(
                        (left_span[0], left_span[2]),
                        (right_span[0], right_span[1]),
                        spelling,
                    )
                    # One known operator token between two AST operands is reliable;
                    # nested comparisons belong to their own AST node.
                    if len(between) == 1:
                        item = between[0]
                        self.emit(
                            "comparison",
                            (item["start"][0], item["start"][1], item["end"][1]),
                            new_spelling,
                            "flip {} to {}".format(spelling, new_spelling),
                        )
                left = right
        self.generic_visit(node)

    def visit_BoolOp(self, node):
        if not self.excluded(node):
            spelling = "and" if isinstance(node.op, ast.And) else "or"
            replacement = "or" if spelling == "and" else "and"
            for item in self.direct_tokens(node, {spelling}):
                self.emit(
                    "boolean",
                    (item["start"][0], item["start"][1], item["end"][1]),
                    replacement,
                    "flip {} to {}".format(spelling, replacement),
                )
        self.generic_visit(node)

    def negate_condition(self, node):
        if self.excluded(node):
            return
        span = self.span(node.test)
        if span is None:
            return
        condition = self.lines[span[0] - 1][span[1]:span[2]]
        self.emit(
            "condition",
            span,
            "not ({})".format(condition),
            "negate the condition",
        )

    def visit_If(self, node):
        self.negate_condition(node)
        self.generic_visit(node)

    def visit_While(self, node):
        self.negate_condition(node)
        self.generic_visit(node)

    def visit_Return(self, node):
        if (
            node.value is not None
            and not self.excluded(node.value)
            and not (
                isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, bool)
            )
        ):
            self.emit(
                "statement",
                self.span(node.value),
                "None",
                "drop the returned value",
            )
        self.generic_visit(node)

    def visit_UnaryOp(self, node):
        if (
            isinstance(node.op, (ast.UAdd, ast.USub))
            and isinstance(node.operand, ast.Constant)
            and isinstance(node.operand.value, (int, float))
            and not isinstance(node.operand.value, bool)
            and not self.excluded(node)
        ):
            self.signed_numbers.add(id(node.operand))
            value = node.operand.value
            if isinstance(node.op, ast.USub):
                value = -value
            self.emit_number(node, value)
        self.generic_visit(node)

    def emit_number(self, node, value):
        if isinstance(value, float) and not math.isfinite(value):
            return
        bumped = value + 1
        if (
            bumped == value
            or (isinstance(bumped, float) and not math.isfinite(bumped))
        ):
            return
        span = self.span(node)
        original = self.lines[node.lineno - 1][span[1]:span[2]] if span else str(value)
        self.emit(
            "number",
            span,
            repr(bumped),
            "bump {} to {}".format(original, repr(bumped)),
        )

    def visit_Constant(self, node):
        if not self.excluded(node):
            value = node.value
            if isinstance(value, bool):
                replacement = "False" if value else "True"
                self.emit(
                    "boolean",
                    self.span(node),
                    replacement,
                    "flip {} to {}".format(value, replacement),
                )
            elif (
                isinstance(value, (int, float))
                and id(node) not in self.signed_numbers
            ):
                self.emit_number(node, value)
            elif isinstance(value, str) and 0 < len(value) <= 40:
                self.emit(
                    "string",
                    self.span(node),
                    "''",
                    "empty the string {}".format(json.dumps(value, ensure_ascii=False)),
                )
        self.generic_visit(node)

    def run(self, tree):
        self.tree = tree
        for parent in ast.walk(tree):
            for child in ast.iter_child_nodes(parent):
                child.parent = parent

        for node in ast.walk(tree):
            body = getattr(node, "body", None)
            if (
                isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                self.docstrings.add(id(body[0].value))

            if isinstance(node, ast.Assign):
                value = node.value
            elif isinstance(node, ast.AnnAssign):
                value = node.value
            else:
                continue
            if value is not None and is_plain_constant(value):
                for descendant in ast.walk(value):
                    self.constant_declarations.add(id(descendant))

        self.tokenize()
        self.visit(tree)
        self.candidates.sort(key=lambda item: (
            item["line"], item["column"], item["kind"], item["mutated"]))
        return self.candidates


def analyze(source, profile="logic"):
    tree = ast.parse(source)
    return PythonMutator(source, profile).run(tree)


if __name__ == "__main__":
    try:
        text = sys.stdin.buffer.read().decode("utf-8")
        if text.startswith("﻿"):
            text = text[1:]
        profile = sys.argv[1] if len(sys.argv) > 1 else "logic"
        result = analyze(text, "strict" if profile == "strict" else "logic")
        sys.stdout.write(json.dumps({"mutations": result}, ensure_ascii=True))
    except SyntaxError as error:
        sys.stdout.write(json.dumps({
            "parseError": "Python syntax error on line {}: {}".format(
                error.lineno or "?", error.msg),
        }))
    except Exception as error:
        sys.stdout.write(json.dumps({
            "parseError": "Python analysis failed: {}: {}".format(
                type(error).__name__, str(error)),
        }))
