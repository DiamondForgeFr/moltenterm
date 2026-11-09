// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// SPDX licence expressions, as far as the notices need them (#2126): `MIT`, `(MIT OR Apache-2.0)`, `MIT AND Zlib`,
// `Apache-2.0 WITH LLVM-exception`, `GPL-2.0+`. A package is allowed when its expression is, which takes the licences it
// is offered under (OR: one allowed alternative is enough, the one relied on is named) and the ones it is under all at
// once (AND: every one).

const Operators = new Set(["AND", "OR", "WITH"]);

// An expression as a tree: { id }, { id, exception }, { op: "AND" | "OR", left, right }.
export function parseExpression(text) {
  if (typeof text !== "string") {
    throw new Error("not a licence expression");
  }
  const tokens = text.match(/\(|\)|[^\s()]+/g) ?? [];
  if (tokens.length === 0) {
    throw new Error("empty licence expression");
  }
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];
  const isOperator = (token) => token != null && Operators.has(token.toUpperCase());

  function parseAtom() {
    const token = take();
    if (token == null) {
      throw new Error(`"${text}" ends too early`);
    }
    if (token === "(") {
      const inner = parseOr();
      if (take() !== ")") {
        throw new Error(`"${text}" has an unclosed parenthesis`);
      }
      return inner;
    }
    if (token === ")" || isOperator(token)) {
      throw new Error(`"${text}" has an unexpected "${token}"`);
    }
    const node = { id: token };
    if (peek() != null && peek().toUpperCase() === "WITH") {
      take();
      const exception = take();
      if (exception == null || exception === "(" || exception === ")" || isOperator(exception)) {
        throw new Error(`"${text}" has no exception after WITH`);
      }
      node.exception = exception;
    }
    return node;
  }
  function parseAnd() {
    let left = parseAtom();
    while (peek() != null && peek().toUpperCase() === "AND") {
      take();
      left = { op: "AND", left, right: parseAtom() };
    }
    return left;
  }
  function parseOr() {
    let left = parseAnd();
    while (peek() != null && peek().toUpperCase() === "OR") {
      take();
      left = { op: "OR", left, right: parseAnd() };
    }
    return left;
  }

  const tree = parseOr();
  if (at !== tokens.length) {
    throw new Error(`"${text}" has an unexpected "${tokens[at]}"`);
  }
  return tree;
}

export function idsOf(tree) {
  if (tree.id != null) {
    return [tree.id];
  }
  return [...idsOf(tree.left), ...idsOf(tree.right)];
}

// `GPL-2.0+` is read as the id it extends: the allow-list names ids, never ranges.
function baseId(id) {
  return id.endsWith("+") ? id.slice(0, -1) : id;
}

// { allowed, relied } : whether the expression is allowed by the ids of `allowed`, and the ids the verdict rests on.
export function evaluate(tree, allowed) {
  if (tree.id != null) {
    const ok = allowed.has(baseId(tree.id));
    return { allowed: ok, relied: ok ? [tree.id] : [] };
  }
  const left = evaluate(tree.left, allowed);
  const right = evaluate(tree.right, allowed);
  if (tree.op === "AND") {
    return left.allowed && right.allowed
      ? { allowed: true, relied: [...left.relied, ...right.relied] }
      : { allowed: false, relied: [] };
  }
  if (left.allowed) {
    return left;
  }
  return right;
}

// The expression as written back, normalised: operators upper case, one space around them, parentheses only where the
// operators change.
export function formatExpression(tree, parentOp = null) {
  if (tree.id != null) {
    return tree.exception != null ? `${tree.id} WITH ${tree.exception}` : tree.id;
  }
  const text = `${formatExpression(tree.left, tree.op)} ${tree.op} ${formatExpression(tree.right, tree.op)}`;
  return parentOp != null && parentOp !== tree.op ? `(${text})` : text;
}
