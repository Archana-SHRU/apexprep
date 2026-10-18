/**
 * Mathematical notation, reduced to one canonical plain form before any text comparison.
 *
 * Course notes say "v = ωR" or "v = omega R"; a model writes "$v = \omega R$" or "\frac{2}{3}MR^{2}". To a
 * word-overlap measure those look like different claims, and LaTeX commands (`frac`, `mathrm`, `cdot`) even
 * look like extra, unsupported words — which is why a correct, notes-based explanation written in LaTeX scored
 * as weakly grounded. Normalising both sides the same way removes **formatting only**:
 *
 *   * math delimiters and spacing/sizing commands disappear (`$`, `\(`, `\left`, `\quad`, …);
 *   * wrappers keep their content (`\text{net force}` → `net force`, `\frac{a}{b}` → `a / b`, `\sqrt{x}` → `sqrt x`);
 *   * Greek letters get one name, whether written `\omega`, `ω` or `omega`;
 *   * superscripts and subscripts become ordinary separators (`R²`, `R^{2}` and `R^2` all read the same).
 *
 * It never adds a word that was not written, so a claim the notes do not make stays unsupported. Pure.
 */

const GREEK_LETTERS: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', Γ: 'gamma', δ: 'delta', Δ: 'delta', ε: 'epsilon', ϵ: 'epsilon', ζ: 'zeta', η: 'eta',
  θ: 'theta', Θ: 'theta', ϑ: 'theta', ι: 'iota', κ: 'kappa', λ: 'lambda', Λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', Ξ: 'xi',
  π: 'pi', Π: 'pi', ρ: 'rho', σ: 'sigma', Σ: 'sigma', τ: 'tau', υ: 'upsilon', φ: 'phi', ϕ: 'phi', Φ: 'phi', χ: 'chi',
  ψ: 'psi', Ψ: 'psi', ω: 'omega', Ω: 'omega',
};
const GREEK_NAMES = [...new Set(Object.values(GREEK_LETTERS)), 'varepsilon', 'vartheta', 'varphi', 'varrho', 'varsigma'];

const SUPERSCRIPTS: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', 'ⁿ': 'n' };
const SUBSCRIPTS: Record<string, string> = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };

/** LaTeX commands that only format: dropped, never counted as words. */
const FORMATTING_COMMANDS =
  /\\(?:left|right|big|Big|bigg|Bigg|cdot|cdots|ldots|dots|times|div|pm|mp|quad|qquad|displaystyle|textstyle|limits|nolimits|mathrm|mathbf|mathit|mathsf|mathcal|boldsymbol|vec|hat|bar|overline|underline|tilde|dot|ddot|text|textbf|textit|operatorname|approx|simeq|equiv|propto|leq|geq|le|ge|neq|ne|to|rightarrow|Rightarrow|leftarrow|implies|iff|infty|partial|nabla|,|;|:|!)\b/g;

/** Wrappers whose argument is real content: `\text{net force}` keeps "net force". */
const CONTENT_WRAPPERS = /\\(?:text|mathrm|mathbf|mathit|mathsf|operatorname|textbf|textit|boldsymbol|vec|hat|bar|overline|underline|tilde)\s*\{([^{}]*)\}/g;

export function normalizeMath(input: string): string {
  let s = input;
  // Super/subscript characters first, before NFKC would fold "²" into a bare "2" glued to its base.
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿ]/g, (c) => ` ^ ${SUPERSCRIPTS[c] ?? ''} `).replace(/[₀-₉]/g, (c) => ` _ ${SUBSCRIPTS[c] ?? ''} `);
  s = s.normalize('NFKC');
  s = s.replace(/\$\$?|\\\(|\\\)|\\\[|\\\]/g, ' ');
  s = s.replace(CONTENT_WRAPPERS, ' $1 ');
  // \frac{a}{b}, nested: unwrap from the inside out, bounded so a malformed formula cannot loop.
  for (let i = 0; i < 8 && /\\[dt]?frac\s*\{/.test(s); i += 1) {
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, ' $1 / $2 ');
  }
  s = s.replace(/\\sqrt\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g, ' sqrt $1 ').replace(/√/g, ' sqrt ');
  s = s.replace(new RegExp(`\\\\(${GREEK_NAMES.join('|')})\\b`, 'gi'), (_m, name: string) => ` ${name.toLowerCase().replace(/^var/, '')} `);
  s = s.replace(/[Ͱ-Ͽ]/g, (c) => (GREEK_LETTERS[c] ? ` ${GREEK_LETTERS[c]} ` : c));
  s = s.replace(FORMATTING_COMMANDS, ' ');
  // Any other command: its name is notation, not a claim about the subject.
  s = s.replace(/\\[A-Za-z]+/g, ' ');
  s = s.replace(/[{}^_]/g, ' ').replace(/[×·]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
