// NotebookLM M1 — the /notebooks library screen (T8). A notebook holds sources
// (pdf/epub uploads + url/text); each source is parsed + embedded asynchronously
// by the server ingest worker, so the screen polls GET /sources/:id while the
// status is non-terminal and renders a status badge + indexed/total progress.
//
// `status.*` maps the machine `errorCode` (from @reomi/shared
// INGEST_ERROR_CODES) onto human prose — every error code MUST have an entry in
// BOTH locales (enforced by i18n-parity.test.ts).

const notebooks = {
  title: 'Notebooks',
  subtitle: 'Sourced libraries for grounded study.',

  // Setup notice (degrade, never crash) — shown when /ai/status.notebooksEnabled
  // is false (no embedding key / dimension-degraded).
  setup: {
    title: 'Notebooks aren\'t configured yet.',
    body:
      'Notebooks index your sources with embeddings. Set OPENAI_API_KEY (and keep INDEXING_ENABLED on) in the server environment, then restart the API.',
    docsHint: 'See the AI / RAG section of the project README for the full variable list.',
  },

  // Notebook list (left / top).
  list: {
    heading: 'Your notebooks',
    empty: 'No notebooks yet. Create one to add sources.',
    emptyArchived: 'The archive is empty.',
    searchEmpty: 'Nothing found.',
    create: 'New notebook',
    createTitle: 'New notebook',
    createLabel: 'Title',
    createPlaceholder: 'e.g. Machine Learning',
    rename: 'Rename notebook',
    renameTitle: 'Rename notebook',
    delete: 'Delete notebook',
    deleteConfirm: 'Delete this notebook and its notebook-owned notes, study documents, quizzes and quiz attempts? Conversations, sources, source-owned study work and cards are preserved.',
    sourceCount: '{count} sources',
    tooMany: 'You\'ve reached the notebook limit.',
    search: 'Search notebooks…',
    showArchive: 'Archive',
    showActive: 'Active',
    // «Notebooks redesign» (A3) — screen topbar + list sections + create tile.
    title: 'Notebooks',
    sectionContinue: 'Continue',
    sectionAll: 'All notebooks',
    open: 'Open',
    newCardTitle: 'New notebook',
    newCardHint: 'From library books or files',
  },

  // «Notebooks 2.0» (N1) — metadata, list tiles, the create dialog.
  meta: {
    sourcesChip: '{count} sources',
    notesChip: '{count} notes',
    cardsChip: '{count} cards',
    // «Notebooks redesign» (A3) — card meta line «N sources · M documents».
    sourcesMeta: '{count} sources',
    documentsMeta: '{count} docs',
    metaSep: ' · ',
    generatingTitle: '{title} generating',
    generatingCount: '{count} docs in progress',
    updated: 'updated {time}',
    relativeNow: 'just now',
    relativeMinutes: '{count}m ago',
    relativeHours: '{count}h ago',
    relativeDays: '{count}d ago',
    pin: 'Pin',
    unpin: 'Unpin',
    archive: 'Archive',
    unarchive: 'Unarchive',
    pinned: 'Pinned',
    emojiLabel: 'Icon',
    emojiNone: 'No icon',
    colorLabel: 'Color',
    createDescription: 'Description (optional)',
    saveFailed: 'Could not save. Please try again.',
  },

  // «Notebooks 2.0» (N1) — the notes panel in the right dock.
  notes: {
    notFound: 'This note is unavailable or deleted.',
    tab: 'Notes',
    heading: 'Notes',
    dockExpand: 'Expand notes',
    dockCollapse: 'Collapse notes',
    search: 'Search notes…',
    empty: 'No notes yet. Save chat answers or write your own.',
    searchEmpty: 'Nothing found.',
    add: 'Note',
    addTitle: 'New note',
    titlePlaceholder: 'Title',
    contentPlaceholder: 'Note body (Markdown)…',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    edit: 'Edit',
    delete: 'Delete',
    deleteConfirm: 'Delete this note?',
    pin: 'Pin',
    unpin: 'Unpin',
    badgeAnswer: 'answer',
    toCards: 'To cards',
    toCardsPrompt: 'Make flashcards from this note:\n\n{content}',
    back: 'Back to list',
    charCount: '{count} / {max}',
    tooLong: 'The note is too long.',
    createFailed: 'Could not save the note.',
    savedFromChat: 'Saved to notes',
    saveAnswer: 'To notes',
  },

  // Notebook chat redesign (A2) — empty state, placeholder, scope.
  chat: {
    heroTitle: 'Ask your books',
    heroSubtitle:
      'Answers draw only on the selected sources — every claim links back to a specific place in the book.',
    refreshSuggestions: 'Refresh suggestions',
    composerPlaceholder: 'Ask about the selected sources…',
    // `{count}` — number of sources in the active scope (rail checkboxes).
    sourceScope: '{count} sources',
  },

  plan: {
    tab: 'Plan',
    empty: 'No pages yet',
    ingesting: 'Still loading',
    planned: 'Planned',
    readable: 'Ready to read',
    unavailable: 'Unavailable',
    open: 'Open',
    start: 'Load pages',
  },

  // «Notebooks 2.0» (N2) — the Overview tab (right dock, default).
  overview: {
    tab: 'Overview',
    heading: 'Overview',
    generate: 'Generate overview',
    generating: 'Reading your sources…',
    retry: 'Retry',
    failed: 'Could not generate the overview.',
    cooldown: 'Just a moment — try again shortly.',
    stale: 'Sources changed since this overview was generated.',
    refresh: 'Refresh overview',
    suggestedHeading: 'Suggested questions',
    empty: 'Add sources to generate an overview.',
    setupHint: 'Connect a chat model to generate overviews.',
    // Section headings for the overview tab's coverage + concept-map blocks.
    coverageHeading: 'Card coverage',
    mapHeading: 'Concept map',
  },

  // «Notebooks 2.0» (N2) — the Studio tab (generated artifacts).
  studio: {
    notFound: 'This study artifact is unavailable or deleted.',
    tab: 'Studio',
    heading: 'Studio',
    generateHeading: 'Generate',
    listHeading: 'Documents',
    empty: 'No documents yet. Generate one from your sources.',
    setupHint: 'Connect a chat model to generate study documents.',
    // Generation tiles (icon + name + one-line description).
    type_summary: 'Summary',
    type_summaryDesc: 'A structured briefing of the material.',
    type_study_guide: 'Study guide',
    type_study_guideDesc: 'Key concepts, themes, and self-check questions.',
    type_faq: 'FAQ',
    type_faqDesc: 'The most useful questions, answered.',
    type_timeline: 'Timeline',
    type_timelineDesc: 'Events and stages in order.',
    type_glossary: 'Glossary',
    type_glossaryDesc: 'Key terms with concise definitions.',
    type_quiz: 'Quiz',
    type_quizDesc: 'Self-check questions with grading.',
    // Artifact status badges.
    statusPending: 'Queued',
    statusGenerating: 'Generating…',
    statusError: 'Failed',
    // Live progress of a streaming generation.
    queued: 'queued…',
    elapsedSec: '{seconds}s',
    elapsedMin: '{minutes}m {seconds}s',
    charsK: 'k',
    chars: '≈{chars} chars',
    liveGenerating: 'Generating…',
    quizGenerating: 'Generating quiz… ≈{chars} chars',
    // Row actions + viewer.
    regenerate: 'Regenerate',
    delete: 'Delete',
    deleteConfirm: 'Delete this study document or quiz and its attempts? This cannot be undone.',
    back: 'Back',
    copy: 'Copy',
    copied: 'Copied',
    toNote: 'To a note',
    savedToNote: 'Saved to notes',
    // Full-window document reader.
    download: 'Download .md',
    readerClose: 'Close',
    untitled: 'Document',
    // A4 redesign — ready-document row, cancel generation, list footnote.
    cancelGeneration: 'Cancel generation',
    readyAt: 'Ready · {time}',
    docsHint: 'Documents are generated from the selected sources and saved to the notebook.',
    // Toasts keyed by the machine error code (ARTIFACT_ERROR_CODES) + route codes.
    createFailed: 'Could not generate. Please try again.',
    err_no_sources: 'Select at least one ready source.',
    err_invalid_type: 'That document type is unavailable.',
    err_too_many_artifacts: 'You\'ve reached the document limit.',
    err_generation_in_progress: 'Wait for the current generation to finish.',
    err_not_terminal: 'This document is still generating.',
    err_ai_disabled: 'Connect a chat model first.',
    // Per-artifact error-code prose (notebook_artifacts.error_code).
    error_ai_disabled: 'Chat is not configured.',
    error_timeout: 'Generation timed out.',
    error_generation_failed: 'Generation failed.',
    error_invalid_quiz: 'The generated quiz was malformed.',
    error_no_sources: 'No ready sources to generate from.',
    error_source_unavailable: 'The source is no longer available. Existing study work is preserved.',
    error_interrupted: 'Generation was interrupted — regenerate it.',
  },

  // «Notebooks 2.0» (N3) — the quiz player.
  quiz: {
    // Question-count dialog (studio tile click).
    dialogTitle: 'How many questions?',
    dialogHint: 'Pick how many questions the quiz should have.',
    dialogGenerate: 'Generate quiz',
    // Intro screen.
    introTitle: 'Test yourself',
    questionCount: '{count} questions',
    start: 'Start',
    // In-progress.
    questionOf: 'Question {n} of {total}',
    prev: 'Back',
    next: 'Next',
    finish: 'Finish',
    submitting: 'Scoring…',
    submitFailed: 'Could not submit the attempt.',
    openPlaceholder: 'Type your answer…',
    showAnswer: 'Show answer',
    modelAnswer: 'Model answer',
    selfCorrect: 'I was right',
    selfIncorrect: 'I was wrong',
    tfTrue: 'True',
    tfFalse: 'False',
    empty: 'This quiz has no questions.',
    // Result screen.
    scorePct: '{pct}% correct',
    retry: 'Try again',
    weakSpots: 'Weak spots → cards',
    weakSpotsPrompt: 'Make flashcards for the topics I got wrong:',
    weakSpotsAnswer: 'Answer:',
    breakdownHeading: 'Review',
    inSource: 'Show in source',
    // History.
    history: 'Attempt history',
    historyHeading: 'Attempt history',
    historyEmpty: 'No attempts yet.',
    back: 'Back',
  },

  // «Notebooks 2.0» (N3, Р9) — card-coverage block in the Overview tab. SQL-only
  // (renders without a chat key); only the gap prefill buttons are gated.
  coverage: {
    noSources: 'Add sources to see card coverage.',
    emptyHint: 'No cards from these sources yet — ask the agent to make some.',
    aggregate: '{covered}/{total} chunks · {cards} cards',
    sourceMeta: '{covered}/{total} chunks · {cards} cards',
    gapsHeading: 'Uncovered topics',
    gapMeta: '{count} uncovered chunks · {source}',
    gapAction: 'Make cards for this section',
    gapPrompt: 'Make flashcards for the section "{heading}" of the source "{source}".',
    noHeading: 'untitled',
  },

  // «Notebooks 2.0» (N4, Р10) — concept map block in the Overview tab.
  // Vectors-only (renders without a chat key); degrades to «not indexed».
  map: {
    heading: 'Concept map',
    hint: 'Sections of your sources, linked by similarity. Click a node to open it.',
    part: 'part {n}',
    empty: 'Add sources to see the concept map.',
    notIndexed: 'Your sources aren\'t indexed yet — the map appears once indexing finishes.',
  },

  // «Notebooks 2.0» (N4, Р11) — recommendations in the «Add from library» picker.
  attach: {
    suggestedHeading: 'Recommended',
    suggestedMatch: '{pct}% match',
  },

  // Source list (inside an open notebook).
  sources: {
    heading: 'Sources',
    empty: 'No sources yet. Add a PDF, EPUB, web page, or pasted text.',
    add: 'Add source',
    addTitle: 'Add a source',
    rename: 'Rename source',
    renameTitle: 'Rename source',
    renameLabel: 'Title',
    delete: 'Delete source',
    deleteConfirm: 'Delete this source? Its indexed content is removed.',
    tooMany: 'You\'ve reached the source limit for this notebook.',
    progress: '{indexed} / {total} indexed',
    back: 'Back to notebooks',
    // Sources rail (A4): connect, «In this notebook» section, selection, sublines.
    connectFromLibrary: 'Add from library',
    inThisNotebook: 'In this notebook',
    all: 'all',
    selectAll: 'Select all',
    clearSelection: 'Clear selection',
    selectedOf: '{count} of {total} selected',
    readPercent: '{pct}% read',
    kindPdf: 'PDF',
    kindEpub: 'EPUB',
    kindUrl: 'Web page',
    kindText: 'Text',
    kindYoutube: 'YouTube',
  },

  // Add-source dialog: kind picker + per-kind fields.
  add: {
    kindFile: 'Upload (PDF / EPUB)',
    kindUrl: 'Web page',
    kindText: 'Paste text',
    fileLabel: 'Choose a file',
    filePlaceholder: 'No file selected',
    fileHint: 'PDF or EPUB, up to {mb} MB.',
    urlLabel: 'URL',
    urlPlaceholder: 'https://…',
    titleLabel: 'Title',
    titlePlaceholder: 'Source title',
    textLabel: 'Text',
    textPlaceholder: 'Paste the text to index…',
    submit: 'Add',
    uploading: 'Uploading…',
    failed: 'Could not add the source. Please try again.',
  },

  // Three-panel workspace (M2): sources │ reader │ chat.
  workspace: {
    tabSources: 'Sources',
    tabReader: 'Reading',
    tabChat: 'Chat',
    tabDock: 'Notebook',
    // Per-source "include in chat" checkbox + the generated-cards count button.
    inChat: 'In chat',
    cardsButton: 'Cards',
    cardsCount: '{count} cards',
    cardsLoading: 'Loading…',
    cardsEmpty: 'No cards from this source yet.',
    // W5(a) — collapsible chat column.
    chatCollapse: 'Collapse chat',
    chatExpand: 'Expand chat',
    // Workspace topbar (A4): meta line under the notebook title.
    headerSources: '{count} sources',
    headerMetaSep: ' · ',
  },

  // Center reader (M2 text mode + M4 PDF mode) — the active source's content.
  reader: {
    readingGroup: 'Reading mode',
    inkGroup: 'Document annotation',
    navigationGroup: 'Zoom and pages',
    inkOptions: 'Drawing options',

    empty: 'Select a source to read it here.',
    notReady: 'This source is still being indexed.',
    noText: 'No readable text in this source.',
    page: 'p. {n}',
    chunkCount: '{count} sections',
    loadMore: 'Load more',
    loading: 'Loading…',
    // M4 PDF reader: loading / error.
    loadingBytes: '{loaded} / {total} KB',
    loadError: 'Could not open this PDF.',
    openText: 'Open the text view',
    // Mode toggle.
    modePdf: 'PDF',
    modeText: 'Text',
    // Toolbar (ink tools + zoom + page jump + save state).
    toolbar: 'Reader tools',
    toolHand: 'Move / scroll',
    toolPen: 'Pen',
    toolHighlighter: 'Highlighter',
    toolEraser: 'Eraser',
    toolSmartCard: 'Smart Card — drag to select, AI proposes a flashcard',
    fingerDraw: 'Draw with finger',
    undo: 'Undo',
    redo: 'Redo',
    width: 'Width {n}',
    color_lime: 'Lime',
    color_amber: 'Amber',
    color_rose: 'Rose',
    color_sky: 'Sky',
    color_violet: 'Violet',
    color_white: 'White',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    zoomReset: 'Fit width',
    pageJump: 'Go to page',
    saving: 'Saving…',
    saved: 'Saved',
    saveError: 'Save failed — retry',
  },

  // Card → source backlinks (M3) — the "Sources" panel on a card.
  backlinks: {
    title: 'Sources',
    open: 'Open source',
    tombstone: 'Source removed',
    untitled: 'Source',
    page: 'p. {n}',
  },

  // Feature #2 — «Harvest markup → cards»: collect all un-harvested markup of a
  // source into cards in one AI pass, then an accept/exclude/edit wizard.
  harvest: {
    stale: 'The source or markup changed. Your edits are still here. Reopen this wizard to generate fresh candidates before saving.',
    button: 'Harvest cards from markup',
    loading: 'Reading the markup…',
    nothing: 'Nothing to harvest — highlight some text or mark pages first.',
    cooldown: 'Just harvested — give it a moment.',
    failed: 'Could not harvest cards. Try again later.',
    badge: '✓ in a card',
    title: 'Cards from markup',
    cardOf: 'Card {n} of {m}',
    deckLabel: 'Deck',
    deckPlaceholder: 'Choose a deck',
    frontLabel: 'Front',
    backLabel: 'Back',
    quoteLabel: 'From the passage',
    frontPlaceholder: 'Question…',
    backPlaceholder: 'Answer…',
    include: 'Include',
    exclude: 'Exclude',
    excluded: 'Excluded',
    back: 'Back',
    next: 'Next',
    review: 'Review',
    reviewHint: 'Check the cards before creating them.',
    apply: 'Create ({n})',
    applying: 'Creating…',
    created: '{n} cards created',
    cancel: 'Cancel',
    page: 'p. {n}',
    originMark: 'highlight',
    originInk: 'drawing',
  },

  // M5 — selection marks (highlights + notes) in the PDF reader.
  marks: {
    annotationNotes: 'Margin notes',
    annotationNotesHint: 'Comments on highlighted passages. Select a page to return to the text.',
    noAnnotationNotes: 'Select text in the book and add a note.',
    studyNotes: 'My notes',

    color_orange: 'Orange',
    color_teal: 'Teal',
    color_blue: 'Blue',
    color_pink: 'Pink',
    color_gray: 'Gray',
    selectionTitle: 'Selected passage',
    selectionAskPrompt: 'Explain the selected passage.',
    highlightColors: 'Highlight color',
    copyFailed: 'Could not copy the text.',
    selectionTooLong: 'This selection is too long for this action. Select a shorter passage.',
    panelTitle: 'Markup',
    panelEmpty: 'Select text in the PDF to highlight it or add a note.',
    panelInkPage: 'p. {n} — drawing',
    pageGroup: 'Page {n}',
    highlight: 'Highlight',
    note: 'Note',
    delete: 'Delete',
    deleteConfirm: 'Delete this mark?',
    notePlaceholder: 'Add a note…',
    noteSave: 'Save',
    copyAction: 'Copy',
    askAction: 'Ask',
    cardAction: 'Card',
    openCard: 'Open card',
    export: 'Export to Markdown',
    color_lime: 'Lime',
    color_amber: 'Amber',
    color_rose: 'Rose',
    color_sky: 'Sky',
    color_violet: 'Violet',
  },

  // M5 — Quick card dialog (selection → flashcard).
  quickcard: {
    title: 'New card',
    deckLabel: 'Deck',
    deckPlaceholder: 'Select a deck…',
    frontLabel: 'Front',
    frontPlaceholder: 'Question…',
    backLabel: 'Back',
    backPlaceholder: 'Answer…',
    formulateBtn: '✨ Formulate',
    formulateHint: 'Generate with AI',
    formulateError: 'Could not generate. Fill in manually.',
    cooldown: 'Just a moment — try again shortly.',
    createBtn: 'Create card',
    creating: 'Creating…',
    createError: 'Could not create the card. Try again.',
    created: 'Card created',
    createdOpen: 'open',
    source: 'p. {n} · {title}',
    noDeck: 'No deck selected',
  },

  // Status badge + machine error codes (errorCode → status.<code>).
  status: {
    pending: 'Queued',
    parsing: 'Parsing…',
    indexing: 'Indexing…',
    ready: 'Ready',
    error: 'Failed',
    deleting: 'Removing…',
    // INGEST_ERROR_CODES — one entry per code (parity-enforced).
    too_large: 'File is too large.',
    too_many_chunks: 'Source is too long to index.',
    index_failed: 'AI indexing failed. The file is available to read.',
    parse_failed: 'Could not read this source.',
    fetch_failed: 'Could not fetch this URL.',
    unsupported_mime: 'Unsupported file type.',
    empty_source: 'No readable text found.',
    no_subtitles: 'This video has no subtitles in the content language, Russian, or English.',
    video_unavailable: 'This video is private, deleted, or unavailable.',
  },
};

export default notebooks;
