//! A 3x5 pixel font for the 13x8 matrix: three glyphs fit side by side.
//! Each glyph is 5 rows, top first; bit 2 is the left column.

pub const WIDTH: usize = 3;
pub const HEIGHT: usize = 5;

#[rustfmt::skip]
const GLYPHS: &[(char, [u8; HEIGHT])] = &[
    ('A', [0b010, 0b101, 0b111, 0b101, 0b101]),
    ('B', [0b110, 0b101, 0b110, 0b101, 0b110]),
    ('C', [0b011, 0b100, 0b100, 0b100, 0b011]),
    ('D', [0b110, 0b101, 0b101, 0b101, 0b110]),
    ('E', [0b111, 0b100, 0b110, 0b100, 0b111]),
    ('F', [0b111, 0b100, 0b110, 0b100, 0b100]),
    ('G', [0b011, 0b100, 0b101, 0b101, 0b011]),
    ('H', [0b101, 0b101, 0b111, 0b101, 0b101]),
    ('I', [0b111, 0b010, 0b010, 0b010, 0b111]),
    ('J', [0b001, 0b001, 0b001, 0b101, 0b010]),
    ('K', [0b101, 0b101, 0b110, 0b101, 0b101]),
    ('L', [0b100, 0b100, 0b100, 0b100, 0b111]),
    ('M', [0b101, 0b111, 0b111, 0b101, 0b101]),
    ('N', [0b110, 0b101, 0b101, 0b101, 0b101]),
    ('O', [0b010, 0b101, 0b101, 0b101, 0b010]),
    ('P', [0b110, 0b101, 0b110, 0b100, 0b100]),
    ('Q', [0b010, 0b101, 0b101, 0b110, 0b011]),
    ('R', [0b110, 0b101, 0b110, 0b101, 0b101]),
    ('S', [0b011, 0b100, 0b010, 0b001, 0b110]),
    ('T', [0b111, 0b010, 0b010, 0b010, 0b010]),
    ('U', [0b101, 0b101, 0b101, 0b101, 0b111]),
    ('V', [0b101, 0b101, 0b101, 0b101, 0b010]),
    ('W', [0b101, 0b101, 0b111, 0b111, 0b101]),
    ('X', [0b101, 0b101, 0b010, 0b101, 0b101]),
    ('Y', [0b101, 0b101, 0b010, 0b010, 0b010]),
    ('Z', [0b111, 0b001, 0b010, 0b100, 0b111]),
    ('0', [0b111, 0b101, 0b101, 0b101, 0b111]),
    ('1', [0b010, 0b110, 0b010, 0b010, 0b111]),
    ('2', [0b110, 0b001, 0b010, 0b100, 0b111]),
    ('3', [0b110, 0b001, 0b010, 0b001, 0b110]),
    ('4', [0b101, 0b101, 0b111, 0b001, 0b001]),
    ('5', [0b111, 0b100, 0b110, 0b001, 0b110]),
    ('6', [0b011, 0b100, 0b111, 0b101, 0b111]),
    ('7', [0b111, 0b001, 0b010, 0b010, 0b010]),
    ('8', [0b111, 0b101, 0b111, 0b101, 0b111]),
    ('9', [0b111, 0b101, 0b111, 0b001, 0b110]),
    (' ', [0b000, 0b000, 0b000, 0b000, 0b000]),
    ('!', [0b010, 0b010, 0b010, 0b000, 0b010]),
    ('?', [0b110, 0b001, 0b010, 0b000, 0b010]),
    ('.', [0b000, 0b000, 0b000, 0b000, 0b010]),
    (',', [0b000, 0b000, 0b000, 0b010, 0b100]),
    (':', [0b000, 0b010, 0b000, 0b010, 0b000]),
    ('-', [0b000, 0b000, 0b111, 0b000, 0b000]),
    ('+', [0b000, 0b010, 0b111, 0b010, 0b000]),
    ('=', [0b000, 0b111, 0b000, 0b111, 0b000]),
    ('/', [0b001, 0b001, 0b010, 0b100, 0b100]),
    ('\'', [0b010, 0b010, 0b000, 0b000, 0b000]),
    ('<', [0b001, 0b010, 0b100, 0b010, 0b001]),
    ('>', [0b100, 0b010, 0b001, 0b010, 0b100]),
    ('(', [0b010, 0b100, 0b100, 0b100, 0b010]),
    (')', [0b010, 0b001, 0b001, 0b001, 0b010]),
    ('*', [0b000, 0b101, 0b010, 0b101, 0b000]),
    ('#', [0b101, 0b111, 0b101, 0b111, 0b101]),
    ('%', [0b101, 0b001, 0b010, 0b100, 0b101]),
    ('_', [0b000, 0b000, 0b000, 0b000, 0b111]),
];

/// Characters the font can draw (lowercase letters are drawn as uppercase).
pub fn charset() -> String {
    GLYPHS.iter().map(|(c, _)| *c).collect()
}

pub fn glyph(c: char) -> Option<[u8; HEIGHT]> {
    let c = c.to_ascii_uppercase();
    GLYPHS.iter().find(|(g, _)| *g == c).map(|(_, rows)| *rows)
}

/// Renders text as columns, left to right, one blank column between glyphs.
/// Each column is a 5-bit mask, bit `r` = row `r` of the glyph (top = 0).
pub fn columns(text: &str) -> Result<Vec<u8>, char> {
    let mut cols = Vec::new();
    for (i, c) in text.chars().enumerate() {
        let rows = glyph(c).ok_or(c)?;
        if i > 0 {
            cols.push(0);
        }
        for x in 0..WIDTH {
            let mut col = 0u8;
            for (r, bits) in rows.iter().enumerate() {
                if bits >> (WIDTH - 1 - x) & 1 != 0 {
                    col |= 1 << r;
                }
            }
            cols.push(col);
        }
    }
    Ok(cols)
}
