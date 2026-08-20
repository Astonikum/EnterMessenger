const PREVIEW_MARKER = "#preview";
const PREVIEW_MODULE_MARKER = "#preview-module";

function skipQuoted(input, start, quote) {
  for (let index = start + 1; index < input.length; index += 1) {
    if (input[index] === "\\") {
      index += 1;
    } else if (input[index] === quote) {
      return index + 1;
    }
  }

  return input.length;
}

function decodeSingleQuoted(value) {
  return value.replace(/\\([\\'"nrt])/g, (_, character) => ({
    n: "\n",
    r: "\r",
    t: "\t"
  }[character] || character));
}

function readQuoted(input, start) {
  const quote = input[start];
  const end = skipQuoted(input, start, quote);

  if (end > input.length || input[end - 1] !== quote) {
    throw new Error("Название превью не закрыто кавычкой");
  }

  const raw = input.slice(start, end);
  let value;
  try {
    value = quote === '"' ? JSON.parse(raw) : decodeSingleQuoted(raw.slice(1, -1));
  } catch {
    throw new Error("Название превью содержит некорректную строку");
  }

  return {
    value,
    next: end
  };
}

function findBalanced(input, start, opening = "{", closing = "}") {
  let depth = 0;

  for (let index = start; index < input.length; index += 1) {
    const character = input[index];

    if (character === "'" || character === '"' || character === "`") {
      index = skipQuoted(input, index, character) - 1;
      continue;
    }

    if (character === "/" && input[index + 1] === "/") {
      const newline = input.indexOf("\n", index + 2);
      index = newline === -1 ? input.length : newline - 1;
      continue;
    }

    if (character === "/" && input[index + 1] === "*") {
      const end = input.indexOf("*/", index + 2);
      index = end === -1 ? input.length : end + 1;
      continue;
    }

    if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) {
        return { value: input.slice(start + 1, index), next: index + 1 };
      }
    }
  }

  throw new Error(`Блок ${opening} ... ${closing} не закрыт`);
}

function parseProps(input) {
  if (!input.startsWith("{")) {
    throw new Error("Props должны быть JSON-объектом, например {\"size\":\"large\"}");
  }

  const balanced = findBalanced(input, 0);
  if (input.slice(balanced.next).trim()) {
    throw new Error("После props найден лишний текст");
  }

  try {
    const props = JSON.parse(`{${balanced.value}}`);
    if (!props || Array.isArray(props) || typeof props !== "object") {
      throw new Error();
    }
    return props;
  } catch {
    throw new Error("Props превью содержат некорректный JSON");
  }
}

function parseExpression(input) {
  if (!input.startsWith("{")) {
    throw new Error("Ожидалось тело превью в формате { <Component /> }");
  }

  const balanced = findBalanced(input, 0);
  if (input.slice(balanced.next).trim()) {
    throw new Error("После тела превью найден лишний текст");
  }

  const expression = balanced.value.trim();
  if (!expression) {
    throw new Error("Тело превью не может быть пустым");
  }

  return expression;
}

function parseParenthesizedLabel(input) {
  const balanced = findBalanced(input, 0, "(", ")");
  const value = balanced.value.trim();
  if (!value) {
    return { label: undefined, next: balanced.next };
  }

  if (value[0] !== '"' && value[0] !== "'") {
    throw new Error("Название в #preview(...) должно быть строкой");
  }

  const quoted = readQuoted(value, 0);
  if (value.slice(quoted.next).trim()) {
    throw new Error("В #preview(...) допускается только одно название");
  }

  return { label: quoted.value, next: balanced.next };
}

function parseDeclaration(raw, index, start, end, marker = PREVIEW_MARKER) {
  let input = raw.trim();
  let label;
  let expressionSyntax = false;

  if (marker === PREVIEW_MODULE_MARKER) {
    if (input.startsWith("(")) {
      const parsedLabel = parseParenthesizedLabel(input);
      label = parsedLabel.label;
      input = input.slice(parsedLabel.next).trim();
    }

    if (!input) {
      throw new Error("Модуль превью не может быть пустым");
    }

    return {
      id: String(start),
      index,
      kind: "module",
      label: label || "Preview module",
      target: undefined,
      props: {},
      expression: undefined,
      module: input,
      start,
      end
    };
  }

  if (input.startsWith("(")) {
    const parsedLabel = parseParenthesizedLabel(input);
    label = parsedLabel.label;
    input = input.slice(parsedLabel.next).trim();
    expressionSyntax = true;
  } else if (input.startsWith('"') || input.startsWith("'")) {
    const quoted = readQuoted(input, 0);
    label = quoted.value;
    input = input.slice(quoted.next).trim();
  }

  if (expressionSyntax || input.startsWith("{")) {
    return {
      id: String(start),
      index,
      kind: "expression",
      label: label || "Preview",
      target: undefined,
      props: {},
      expression: parseExpression(input),
      start,
      end
    };
  }

  const targetMatch = /^(default|[A-Za-z_$][\w$]*)/.exec(input);
  if (!targetMatch) {
    throw new Error("Ожидалось имя экспортируемого React-компонента или JSX-тело");
  }

  const target = targetMatch[1];
  const propsText = input.slice(targetMatch[0].length).trim();

  return {
    id: String(start),
    index,
    kind: "props",
    label: label || target,
    target,
    props: propsText ? parseProps(propsText) : {},
    expression: undefined,
    start,
    end
  };
}

function getCommentPreview(text, commentStart, contentStart, commentEnd) {
  const content = text.slice(contentStart, commentEnd);
  const marker = new RegExp(`^[\\t \\r\\n]*(${PREVIEW_MODULE_MARKER}|${PREVIEW_MARKER})\\b`).exec(content);
  if (!marker) {
    return undefined;
  }

  return {
    raw: content.slice(marker[0].length),
    marker: marker[1],
    start: commentStart,
    end: commentEnd
  };
}

function looksLikeRegex(text, index) {
  const before = text.slice(0, index).match(/(?:^|[([{=,:;!&|?+\-*%^~])\s*$/);
  return Boolean(before);
}

function skipRegex(text, start) {
  let inCharacterClass = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") {
      inCharacterClass = true;
    } else if (character === "]") {
      inCharacterClass = false;
    } else if (character === "/" && !inCharacterClass) {
      while (/[A-Za-z]/.test(text[index + 1] || "")) {
        index += 1;
      }
      return index + 1;
    }
  }

  return text.length;
}

function collectComments(text) {
  const matches = [];

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === "'" || character === '"' || character === "`") {
      index = skipQuoted(text, index, character) - 1;
      continue;
    }

    if (character !== "/") {
      continue;
    }

    if (text[index + 1] === "/") {
      const end = text.indexOf("\n", index + 2);
      const commentEnd = end === -1 ? text.length : end;
      const preview = getCommentPreview(text, index, index + 2, commentEnd);
      if (preview) {
        matches.push(preview);
      }
      index = commentEnd - 1;
      continue;
    }

    if (text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const commentEnd = end === -1 ? text.length : end + 2;
      const preview = getCommentPreview(text, index, index + 2, end === -1 ? text.length : end);
      if (preview) {
        matches.push(preview);
      }
      index = commentEnd - 1;
      continue;
    }

    if (looksLikeRegex(text, index)) {
      index = skipRegex(text, index) - 1;
    }
  }

  return matches.sort((left, right) => left.start - right.start);
}

function parsePreviews(text) {
  const previews = [];
  const errors = [];

  for (const match of collectComments(text)) {
    try {
      previews.push(parseDeclaration(match.raw, previews.length, match.start, match.end, match.marker));
    } catch (error) {
      errors.push({ start: match.start, end: match.end, message: error.message });
    }
  }

  return { previews, errors };
}

module.exports = { parsePreviews };

