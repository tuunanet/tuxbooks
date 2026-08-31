/**
 * Original placeholder content for the reader stage — no rendering engines
 * yet, so the shell needs a realistic document to stand in for the real
 * EPUB/PDF renderers. All prose here is original to tuxbooks' fixtures.
 */

export interface PlaceholderPage {
  heading?: string;
  paragraphs: string[];
}

export const PDF_PLACEHOLDER_PAGE_COUNT = 24;

const CHAPTERS: { title: string; paragraphs: string[][] }[] = [
  {
    title: "The Long Shelf",
    paragraphs: [
      [
        "A library is an argument that things should be kept. Every shelf is a small act of defiance against forgetting, and every borrower's card a signature on the petition.",
        "The stacks breathe at night. Paper expands with the damp, covers cool after the lights go out, and somewhere a spine settles a fraction of a degree, the way an old house speaks only when nobody listens for it.",
        "She had worked the evening shift long enough to know the building's moods: the draft at the periodicals, the warmth above the reference desk, the hush that gathered near the rare books room like weather.",
      ],
      [
        "Cataloguing was meditation with a deadline. A book arrived as a stranger; by the time its fields were filled it had a name, a birthplace, a history of hands.",
        "The rules said to describe the object, not the story. But every description was a tiny biography, and every cross-reference an introduction at a party where nobody spoke aloud.",
        "By closing time the trolley stood empty, and the day's arrivals had taken their places in the dark like instruments waiting for their orchestra.",
      ],
    ],
  },
  {
    title: "Indexes of Attention",
    paragraphs: [
      [
        "An index is a map of someone else's curiosity. You can read a chapter and learn the author's mind; read the index and learn the reader's.",
        "Marginalia were the honest part of any volume. The faint pencil beside a paragraph said more about a book's life than the print ever did — agreement, outrage, a single underlined word holding decades of emphasis.",
        "In the reading room, attention had a sound: pages turning at uneven intervals, a chair adjusted, the particular silence of someone thinking hard enough to forget to breathe.",
      ],
      [
        "The catalogue drawers were a forest of small handles, each one opening a drawer of someone's life work reduced to a card. Type small enough to require trust.",
        "She liked the cards best when they were worn soft at the corners. It meant the book had been found, and found again, and argued with.",
        "Reference numbers were promises: that a thought could be found again exactly where it was left, that order was not a fiction the library told itself each morning.",
      ],
    ],
  },
  {
    title: "Margins and Marginalia",
    paragraphs: [
      [
        "Every book is two texts: the one the author set down and the one the reader carries through it. The margin is where they argue.",
        "A notation in the gutter, half erased, read simply 'no — but see p. 41'. She turned to page forty-one and found a paragraph that changed the shape of her week.",
        "Ownership plates, coupons for long-expired services, a pressed leaf at midsummer's chapter: the physical book kept its own diary of being owned.",
      ],
      [
        "Librarians do not annotate. It was the first rule she learned and the hardest she kept, because the temptation of a good pencil and a better sentence is a quiet kind of gravity.",
        "Instead she wrote on slips that slid between pages like bookmarks with ambitions, and in the evening the slips went home with her in pockets, transcribed into notebooks nobody would ever catalogue.",
        "The building kept its own records anyway — sun-faded spines where books stood facing a window for years, dust shadows tracing the outlines of volumes removed in a hurry.",
      ],
    ],
  },
  {
    title: "Due Dates",
    paragraphs: [
      [
        "A due date is a small piece of science fiction: a date in the future on which the world is expected to be slightly more orderly than today.",
        "Most books came home on time. The ones that didn't carried stories of their own — moved households, hospital stays, a refusal to part with a chapter unfinished.",
        "The amnesty week each spring was the library's one concession to being human. Fines forgiven, grudges set aside, and the returns desk buried to the elbows in late apologies.",
      ],
      [
        "On her last shift, the newest librarian asked what the job really was. She thought of the breathing stacks, the argued margins, the promised order.",
        "'We keep the arguments going,' she said. 'Books are just the loudest participants.'",
        "The lights went out section by section, and the library settled into its long conversation with the dark, patient as only a building full of voices can be.",
      ],
    ],
  },
];

/**
 * The placeholder EPUB: each chapter split into two pages so pagination,
 * position, and the navigation drawer all have something true to act on.
 */
export function epubPlaceholderPages(): PlaceholderPage[] {
  return CHAPTERS.flatMap((chapter) =>
    chapter.paragraphs.map((paragraphs, index) => ({
      heading: index === 0 ? chapter.title : undefined,
      paragraphs,
    })),
  );
}

export const EPUB_PLACEHOLDER_PAGE_COUNT = CHAPTERS.length * 2;
