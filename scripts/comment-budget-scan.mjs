// Comment scanning for the per-file comment budget (tuxbooks-hxl).
//
// Kept separate from the gate so each file stays under the repo's 500-line
// limit. The lexers skip strings, templates, raw strings, chars, lifetimes,
// and regex literals; comments inside those constructs are not comments.

export const CAP = 10;
const MAX_OVERRIDE = 20;

const DIRECTIVE_PREFIX =
  /^(?:eslint-[a-z-]+|@ts-[a-z-]+|oxlint-[a-z-]+|biome-[a-z-]+|prettier-ignore|rustfmt::|clippy::|noinspection|SAFETY:|comment-budget:)/;
const OVERRIDE_LINE = /^\s*\/\/\s*comment-budget:\s*(\d+)\s+because\s+(\S.*?)\s*$/;
const OVERRIDE_PREFIX = /^\s*\/\/\s*comment-budget:/;

function directiveBody(comment) {
  if (comment.lineComment) return comment.text.replace(/^\/\/[/!]?\s*/, "");
  return comment.text
    .replace(/^\/\*+!?\s*/, "")
    .replace(/\*\/$/, "")
    .replace(/^\*\s*/, "")
    .trim();
}

function scan(source, scanCode) {
  const state = {
    source,
    length: source.length,
    index: 0,
    line: 1,
    comments: [],
    advanceTo(end) {
      for (let at = this.index; at < end; at++) {
        if (this.source.charCodeAt(at) === 10) this.line++;
      }
      this.index = end;
    },
    add(kind, start, end, lineComment) {
      const text = this.source.slice(start, end);
      const startLine = this.line;
      this.advanceTo(end);
      this.comments.push({ kind, startLine, endLine: this.line, lineComment, text });
    },
  };

  scanCode(state);

  // A run of consecutive line comments that starts with a directive is one
  // directive block. SAFETY justifications in particular span several lines.
  for (let at = 0; at < state.comments.length; at++) {
    const comment = state.comments[at];
    if (comment.kind === "doc") continue;
    const body = directiveBody(comment);
    if (DIRECTIVE_PREFIX.test(body)) comment.kind = "directive";
    if (comment.lineComment && body.startsWith("SAFETY:")) {
      for (let next = at + 1; next < state.comments.length; next++) {
        const following = state.comments[next];
        if (!following.lineComment || following.kind === "doc") break;
        if (following.startLine !== state.comments[next - 1].endLine + 1) break;
        following.kind = "directive";
      }
    }
  }

  return state.comments;
}

function lineCommentEnd(source, start) {
  const end = source.indexOf("\n", start);
  return end === -1 ? source.length : end;
}

// JSX text may contain a URL such as https://example.com. The scheme colon
// makes it look like a line comment to the scanner; skip it so prose does not
// inflate the count.
function isUrlScheme(source, start) {
  return (
    source[start - 1] === ":" &&
    /[A-Za-z]/.test(source[start - 2] ?? "") &&
    source[start + 2] !== undefined &&
    !/\s/.test(source[start + 2])
  );
}

function blockCommentEnd(source, start, nested) {
  let at = start + 2;
  let depth = 1;
  while (at < source.length) {
    if (source[at] === "*" && source[at + 1] === "/") {
      depth--;
      at += 2;
      if (!nested || depth === 0) return at;
    } else if (nested && source[at] === "/" && source[at + 1] === "*") {
      depth++;
      at += 2;
    } else {
      at++;
    }
  }
  return source.length;
}

function consumeTsTemplateCharacter(state) {
  const { source: text, length } = state;
  const character = text[state.index];
  if (character === "\\") {
    state.advanceTo(Math.min(state.index + 2, length));
    return "template";
  }
  if (character === "`") {
    state.index++;
    return "code";
  }
  if (character === "$" && text[state.index + 1] === "{") {
    state.index += 2;
    return "expression";
  }
  if (character === "\n") state.line++;
  state.index++;
  return "template";
}

function consumeTsComment(state) {
  const { source: text } = state;
  const character = text[state.index];
  if (character === "/" && text[state.index + 1] === "/" && !isUrlScheme(text, state.index)) {
    const end = lineCommentEnd(text, state.index);
    const directive = /^\/\/\/\s*<(?:reference|amd-)/.test(text.slice(state.index, end));
    state.add(directive ? "directive" : "explanatory", state.index, end, true);
    return true;
  }
  if (character === "/" && text[state.index + 1] === "*") {
    const doc = text[state.index + 2] === "*" && text[state.index + 3] !== "/";
    const end = blockCommentEnd(text, state.index, false);
    state.add(doc ? "doc" : "explanatory", state.index, end, false);
    return true;
  }
  return false;
}

function consumeTsString(state, jsx) {
  const { source: text } = state;
  const character = text[state.index];
  if (character === "'" && jsx && /[A-Za-z0-9_$]/.test(text[state.index - 1] ?? "")) {
    state.index++;
    return true;
  }
  if (character === '"' || character === "'") {
    state.advanceTo(skipQuoted(text, state.index, character, false));
    return true;
  }
  return false;
}

function scanTs(source, jsx) {
  return scan(source, (state) => {
    const { source: text, length } = state;
    const modes = [];
    let mode = "code";

    if (text.startsWith("#!")) {
      while (state.index < length && text.charCodeAt(state.index) !== 10) state.index++;
    }

    while (state.index < length) {
      if (mode === "template") {
        const next = consumeTsTemplateCharacter(state);
        if (next === "expression") {
          modes.push("template");
          mode = "code";
        } else {
          mode = next;
        }
        continue;
      }

      if (consumeTsComment(state)) continue;

      const character = text[state.index];
      if (character === "/" && regexAllowed(text, state.index, jsx)) {
        state.advanceTo(skipRegex(text, state.index));
        continue;
      }

      if (consumeTsString(state, jsx)) continue;

      if (character === "`") {
        mode = "template";
        state.index++;
        continue;
      }

      if (character === "}" && modes.length > 0) {
        mode = modes.pop();
        state.index++;
        continue;
      }

      if (character === "\n") state.line++;
      state.index++;
    }
  });
}

function skipQuoted(source, start, quote, allowNewline) {
  let at = start + 1;
  while (at < source.length) {
    const character = source[at];
    if (character === "\\") {
      at += 2;
      continue;
    }
    if (character === quote) return at + 1;
    // TypeScript strings cannot contain a raw newline; stopping here keeps a
    // stray apostrophe in JSX text from swallowing the rest of the file.
    if (character === "\n" && !allowNewline) return at;
    at++;
  }
  return source.length;
}

// A slash starts a regex literal unless the previous token can end an
// expression. The heuristic matters because a regex may contain quotes, and
// reading those as string delimiters would swallow the comments that follow.
function regexAllowed(source, slash, jsx) {
  if (source[slash + 1] === "=") return false;
  // </p> and </> are JSX closing tags, not regex literals.
  if (jsx && source[slash - 1] === "<" && /[A-Za-z_$>]/.test(source[slash + 1] ?? "")) return false;
  let at = slash - 1;
  while (at >= 0 && /\s/.test(source[at])) at--;
  if (at < 0) return true;
  if ("([{,;:=!?+-*%^&|~<>".includes(source[at])) return true;
  if (!/[A-Za-z0-9_$]/.test(source[at])) return false;
  let start = at;
  while (start > 0 && /[A-Za-z0-9_$]/.test(source[start - 1])) start--;
  return /^(?:return|case|throw|typeof|void|delete|in|of|yield|await|else|do|new|instanceof)$/.test(
    source.slice(start, at + 1),
  );
}

function skipRegex(source, start) {
  let at = start + 1;
  let inClass = false;
  while (at < source.length) {
    const character = source[at];
    if (character === "\\") {
      at += 2;
    } else if (character === "[") {
      inClass = true;
      at++;
    } else if (character === "]") {
      inClass = false;
      at++;
    } else if (character === "/" && !inClass) {
      at++;
      while (at < source.length && /[a-z]/i.test(source[at])) at++;
      return at;
    } else if (character === "\n") {
      return at;
    } else {
      at++;
    }
  }
  return source.length;
}

function consumeRustComment(state) {
  const { source: text } = state;
  const character = text[state.index];
  if (character === "/" && text[state.index + 1] === "/") {
    const end = lineCommentEnd(text, state.index);
    const doc =
      text[state.index + 2] === "!" ||
      (text[state.index + 2] === "/" && text[state.index + 3] !== "/");
    state.add(doc ? "doc" : "explanatory", state.index, end, true);
    return true;
  }
  if (character === "/" && text[state.index + 1] === "*") {
    const doc =
      text[state.index + 2] === "!" ||
      (text[state.index + 2] === "*" &&
        text[state.index + 3] !== "/" &&
        text[state.index + 3] !== "*");
    const end = blockCommentEnd(text, state.index, true);
    state.add(doc ? "doc" : "explanatory", state.index, end, false);
    return true;
  }
  return false;
}

function consumeRustString(state) {
  const { source: text, length } = state;
  const character = text[state.index];
  if (character === "r" || character === "b" || character === "c") {
    const prefix = /^(?:br|cr|r)(#*)"/.exec(text.slice(state.index, state.index + 32));
    if (prefix) {
      const close = '"' + prefix[1];
      const start = state.index + prefix[0].length;
      const end = text.indexOf(close, start);
      state.advanceTo(end === -1 ? length : end + close.length);
      return true;
    }
  }
  if (character === '"') {
    state.advanceTo(skipQuoted(text, state.index, '"', true));
    return true;
  }
  if (character === "'") {
    state.advanceTo(skipRustCharOrLifetime(text, state.index));
    return true;
  }
  return false;
}

function scanRust(source) {
  return scan(source, (state) => {
    const { length } = state;
    while (state.index < length) {
      if (consumeRustComment(state)) continue;
      if (consumeRustString(state)) continue;
      if (state.source[state.index] === "\n") state.line++;
      state.index++;
    }
  });
}

function skipRustCharOrLifetime(source, start) {
  let at = start + 1;
  if (source[at] === "\\") {
    at++;
    if (source[at] === "x") {
      at += 3;
    } else if (source[at] === "u" && source[at + 1] === "{") {
      at = source.indexOf("}", at) + 1;
    } else {
      at++;
    }
    return source[at] === "'" ? at + 1 : start + 1;
  }
  if (source[at + 1] === "'") return at + 2;
  if (source[at + 2] === "'") return at + 3;
  return start + 1;
}

export function countSource(source, path) {
  const comments = path.endsWith(".rs") ? scanRust(source) : scanTs(source, path.endsWith(".tsx"));
  const counted = new Set();
  for (const comment of comments) {
    if (comment.kind === "doc" || comment.kind === "directive") continue;
    for (let line = comment.startLine; line <= comment.endLine; line++) counted.add(line);
  }
  return { count: counted.size, comments };
}

export function parseOverride(source) {
  const lines = source.split(/\r?\n/);
  let found = null;
  for (let at = 0; at < lines.length; at++) {
    if (!OVERRIDE_PREFIX.test(lines[at])) continue;
    if (at >= 5) return { error: "comment-budget must be in the first five lines" };
    const match = OVERRIDE_LINE.exec(lines[at]);
    if (!match) return { error: "malformed comment-budget directive" };
    if (found) return { error: "more than one comment-budget directive" };
    const budget = Number(match[1]);
    if (!Number.isInteger(budget) || budget > MAX_OVERRIDE) {
      return { error: `comment-budget must be between 0 and ${MAX_OVERRIDE}` };
    }
    found = { budget };
  }
  return found;
}

export function budgetFor(baseCount, absentAtBase, override) {
  const allowed = baseCount === null || baseCount <= CAP ? CAP : baseCount;
  if (!override) return { allowed };
  if (override.error) return { error: override.error };
  if (!absentAtBase && (baseCount ?? 0) < override.budget) {
    return { error: "comment-budget cannot raise an existing file above its base count" };
  }
  return { allowed: absentAtBase ? override.budget : Math.max(allowed, override.budget) };
}
