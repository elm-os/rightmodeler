function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

export function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
      continue;
    }
    if (character === "*") {
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    if (character === "{") {
      const close = glob.indexOf("}", index + 1);
      if (close !== -1) {
        const alternatives = glob
          .slice(index + 1, close)
          .split(",")
          .map((part) => part.split("").map(escapeRegex).join(""));
        source += `(?:${alternatives.join("|")})`;
        index = close;
        continue;
      }
    }
    source += escapeRegex(character);
  }
  return new RegExp(`${source}$`);
}

export function matchesFilePatterns(
  filePath: string,
  patterns: readonly string[],
): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

export function samplePath(patterns: readonly string[]): string {
  for (const pattern of patterns) {
    if (pattern.includes(".env")) return ".env";
    const braced = /\.\{([^}]+)\}/.exec(pattern);
    if (braced !== null) return `src/example.${braced[1]!.split(",")[0]}`;
    if (pattern.includes("yaml")) return "config/models.yaml";
    if (pattern.includes("yml")) return "config/models.yml";
    const extension = /\.([A-Za-z0-9]+)$/.exec(pattern);
    if (extension !== null) return `src/example.${extension[1]}`;
  }
  return "src/example";
}
