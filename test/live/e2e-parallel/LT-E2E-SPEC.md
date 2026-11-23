# Acceptance fixture: two independent Python modules

The two modules below are independent of each other. Each must be implemented and tested in its own
directory. Use only the Python standard library. Do not create or change files outside `textstats/` and `money/`.

## Module 1: `textstats/`

File `textstats/textstats.py`:

- `word_count(text)` returns the number of words in `text`. A word is a maximal run of characters matching
  the regular expression `[A-Za-z0-9']+`. It raises `TypeError` when `text` is not a `str`.
- `top_words(text, n)` lowercases the words of `text` (same word definition), counts them and returns a list of
  `(word, count)` tuples sorted by count descending, then word ascending, limited to the first `n` items.
  It raises `ValueError` when `n` is less than 1.

File `textstats/test_textstats.py`: exactly four `unittest` test methods, importing with
`from textstats import word_count, top_words`:

1. `word_count("Hello, world! It's 2026.")` equals `4`.
2. `word_count(42)` raises `TypeError`.
3. `top_words("b a b c a b", 2)` equals `[("b", 3), ("a", 2)]`.
4. `top_words("a", 0)` raises `ValueError`.

Test command (PowerShell, run from the workspace root): `& '__PYTHON__' -m unittest discover -s textstats -v`

## Module 2: `money/`

File `money/money.py`:

- `parse_amount(text)` accepts an optional leading `¥` or `CNY ` prefix, digits with optional `,` thousands
  separators and an optional decimal part of one or two digits, and returns a `decimal.Decimal` quantized to
  two decimal places (`"¥1,234.5"` gives `Decimal("1234.50")`, `"CNY 12"` gives `Decimal("12.00")`).
  Any other input, including an empty string, raises `ValueError`.
- `format_amount(value)` formats a `Decimal` as `¥` followed by the amount with `,` thousands separators and
  exactly two decimals; negative amounts start with `-` (`Decimal("-3")` gives `"-¥3.00"`).

File `money/test_money.py`: exactly four `unittest` test methods, importing with
`from money import parse_amount, format_amount`:

1. `parse_amount("¥1,234.5")` equals `Decimal("1234.50")`.
2. `parse_amount("CNY 12")` equals `Decimal("12.00")`.
3. `parse_amount("12,34")` raises `ValueError`.
4. `format_amount(Decimal("-1234567.891"))` equals `"-¥1,234,567.89"`.

Test command (PowerShell, run from the workspace root): `& '__PYTHON__' -m unittest discover -s money -v`
