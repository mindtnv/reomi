const m = {
  // Thread list (left rail)
  threads: {
    actions: 'Conversation actions',
    resize: 'Conversation list width',
    title: 'Conversations',
    newThread: 'New chat',
    empty: 'No conversations yet.',
    untitled: 'New conversation',
    delete: 'Delete conversation',
    deleteConfirm: 'Delete this conversation? Its messages are removed for good.',
    rename: 'Rename',
    // Relative "updated N ago" line under each thread title. `{time}` is the
    // pre-formatted relative duration (e.g. "3 h", "2 d"), built in code.
    updatedAgo: 'updated {time} ago',
    relativeNow: 'just now',
    relativeMinutes: '{count} min',
    relativeHours: '{count} h',
    relativeDays: '{count} d',
    // Search + date groups + pin (agentic-environment pack, A1/A2/C4).
    searchPlaceholder: 'Search conversations…',
    searchNoResults: 'No conversations match.',
    groupPinned: 'Pinned',
    groupToday: 'Today',
    groupYesterday: 'Yesterday',
    groupWeek: 'Previous 7 days',
    groupOlder: 'Older',
    pin: 'Pin',
    unpin: 'Unpin',
  },
  // Message stream (right pane)
  stream: {
    emptyTitle: 'Ask your cards.',
    emptySubtitle:
      'Chat is grounded in your own cards. Answers cite the cards they came from; anything outside your cards is labelled as such.',
    you: 'You',
    assistant: 'Assistant',
    // Assistant name in the answer header (A2 redesign).
    assistantName: 'Reomi',
    // «by N sources» meta in a notebook answer header (N = scope size).
    bySources: 'by {count} sources',
    thinking: 'Thinking…',
    sources: 'From your cards',
    sourcesCount: 'Cards used: {count}',
    sourceDeck: 'Deck',
    // Smart scroll (B1) + day separators (B2).
    jumpToBottom: 'Jump to latest',
    newMessages: 'New messages',
    today: 'Today',
    yesterday: 'Yesterday',
  },
  // Composer
  composer: {
    placeholder: 'Ask about your cards or tell me what to do…',
    send: 'Send',
    sending: 'Sending…',
    // Caption next to the Enter badge in the composer's bottom row (A2 redesign).
    sendHint: 'to send',
    // Disclaimer under the composer (both modes).
    disclaimer: 'Answers may be inaccurate — verify anything important against the source.',
    // Stop the in-flight stream (toggles in for Send while streaming).
    stop: 'Stop',
    // Model (reasoning-level) picker — hidden when no allow-list is configured.
    model: 'Model',
    // Optional per-turn deck scope picker.
    deckScope: 'Scope to deck',
    allDecks: 'All cards',
    // @-mention popover sections (D1).
    mentionDecks: 'Decks',
    mentionCards: 'Cards',
    mentionNoResults: 'No matches',
    removeMention: 'Remove mention',
    // Deep-research mode toggle (visible when the server offers fetch_page).
    research: 'Deep research',
    researchHint: 'Deep research mode: the agent reads pages thoroughly before answering and drafting cards',
    researchPlaceholder: 'Paste a link or name a topic to research in depth…',
    attach: 'Attach a file',
    removeAttachment: 'Remove attachment',
    attachLimit: 'Up to 4 attachments per message',
    attachTooBig: 'File is too large',
    attachUnsupported: 'Unsupported file type',
    attachFailed: 'Upload failed',
  },
  // Slash-command templates (D2) — `/` at the start of the draft opens the menu;
  // picking one inserts the localized template ({deck} = the biggest deck).
  slash: {
    quizLabel: 'Quiz',
    quizTemplate: 'Quiz me on {deck}: 5 questions, one at a time, grade my answers.',
    forecastLabel: 'Forecast',
    forecastTemplate: 'What does my review load look like for the next 2 weeks?',
    statsLabel: 'Stats',
    statsTemplate: 'How did I study over the last 30 days? What should I improve?',
    reviewLabel: 'Review',
    reviewTemplate: 'What should I review today in {deck} and why?',
    researchLabel: 'Research',
    researchTemplate: 'Study this page in depth and turn it into atomic flashcards: ',
  },
  // Suggested prompts — pills on the empty state of a NEW conversation, built
  // client-side from the store mirror (deck names / due counts). Click = send.
  suggested: {
    dueToday: 'What should I review today?',
    deckProgress: 'How am I doing in {name}?',
    failing: 'What do I fail most often?',
    quiz: 'Quiz me on {name}',
  },
  // Setup notice (chatEnabled === false)
  unavailable: {
    title: 'Chat is unavailable',
    service: 'The chat service is currently unavailable. Try again later — your cards and library are still available.',
    connection: 'We could not connect to the chat service. Check your connection and try again.',
    retry: 'Try again',
    checking: 'Checking chat availability…',
    cards: 'Go to cards',
    reference: 'Support reference: {id}',
  },
  // Streamed reasoning trace (collapsible, ephemeral — never persisted)
  reasoning: {
    label: 'Reasoning',
    show: 'Show reasoning',
    hide: 'Hide reasoning',
  },
  // Per-assistant-message actions (copy prose, regenerate the turn).
  message: {
    copy: 'Copy',
    copied: 'Copied',
    regenerate: 'Regenerate',
    // Short label for the «again» action in the action row (A2 redesign).
    regenerateShort: 'Again',
    openCard: 'Open card',
    // Recovery affordance on a trailing user turn with no answer (stopped/torn).
    stoppedRetry: 'Stopped — regenerate?',
    // Edit-and-rerun the last user message (Codex-like redesign, AC4.1).
    edit: 'Edit',
    editSave: 'Save and re-run',
    editCancel: 'Cancel edit',
    // Code-block copy buttons (B3) + the model · tokens badge (B6) + queue (D4).
    codeCopy: 'Copy code',
    codeCopied: 'Copied',
    tokens: '{count} tok',
    queued: 'Queued',
    queuedCancel: 'Cancel queued message',
  },
  // Agentic tool calls (search_cards / web_search) surfaced as cards in the stream
  tool: {
    list_source_artifacts: 'List source study work',
    get_source_artifact: 'Read source study document',
    list_source_quiz_attempts: 'Read source quiz attempts',

    list_source_notes: 'List source notes',
    get_source_note: 'Read source note',
    save_source_note: 'Save source note',
    get_capabilities: 'Check AI capabilities',
    list_cards: 'List cards',
    list_tags: 'List tags',
    get_review_queue: 'Read review queue',
    get_card_sources: 'Read card sources',
    get_similar_cards: 'Find similar cards',
    get_semantic_graph: 'Read knowledge graph',
    list_note_types: 'List note types',
    list_deck_options: 'Read deck options',
    list_filtered_decks: 'List saved study decks',
    get_retention: 'Read retention',
    list_library: 'List library materials',
    search_library: 'Search library',
    get_library_item: 'Read material details',
    read_source_chunks: 'Read material',
    read_source: 'Read source',
    search_source: 'Search sources',
    list_marked_passages: 'Read marked passages',
    get_source_cards: 'Read source cards',
    get_source_marks: 'Read highlights and bookmarks',
    get_source_annotations: 'Read PDF annotations',
    list_notebooks: 'List notebooks',
    get_notebook: 'Read notebook details',
    list_notebook_sources: 'List notebook sources',
    list_notebook_notes: 'List notebook notes',
    list_artifacts: 'List studio artifacts',
    get_artifact: 'Read studio artifact',
    list_quiz_attempts: 'Read quiz attempts',
    get_notebook_coverage: 'Read card coverage',
    get_concept_map: 'Read concept map',
    create_deck: 'Create deck',
    update_deck: 'Update deck',
    delete_deck: 'Delete deck',
    create_notebook: 'Create notebook',
    update_notebook: 'Update notebook',
    delete_notebook: 'Delete notebook',
    update_note: 'Update note',
    delete_note: 'Delete note',
    attach_source: 'Attach material',
    detach_source: 'Detach material',
    update_source: 'Update material',
    set_reading_status: 'Set reading status',
    delete_card: 'Delete card',
    delete_flashcard_note: 'Delete flashcard note',
    create_text_source: 'Add library text',
    create_url_source: 'Add library web page',
    list_notes: 'List notes',
    read_note: 'Read note',
    read_context_object: 'Read referenced object',

    deckCount: 'Decks: {count}',
    resultDetails: 'Show full result',
    search_cards: 'Searched your cards',
    web_search: 'Searched the web',
    card_progress: 'Checked card progress',
    study_stats: 'Checked study stats',
    due_forecast: 'Checked upcoming load',
    list_decks: 'Listed your decks',
    browse_cards: 'Browsed your cards',
    get_card: 'Opened a card',
    fetch_page: 'Read a page',
    propose_topic_plan: 'Proposed a study plan',
    // Write/SRS tool labels (B5) — `{front}` = the card's front excerpt,
    // `{deck}` = the target deck name; never a UUID.
    create_card: 'Drafted a card for {deck}',
    create_card_nodeck: 'Drafted a card',
    create_card_batch: 'Drafted {count} cards for {deck}',
    create_card_batch_nodeck: 'Drafted {count} cards',
    edit_card: 'Edited «{front}»',
    suspend: 'Suspended «{front}»',
    set_due: 'Rescheduled «{front}»',
    forget: 'Reset «{front}»',
    // Notebook write tool (Р14 / N3) — `{title}` = the note's title.
    save_note: 'Saved a note: «{title}»',
    save_note_untitled: 'Saved a note',
    // Pluralized labels for a contiguous run of the same tool (AC2.2 collapse).
    get_card_n: 'Reviewed {count} cards',
    card_progress_n: 'Checked progress on {count} cards',
    browse_cards_n: 'Browsed cards {count} times',
    due_forecast_n: 'Checked upcoming load {count} times',
    fetch_page_n: 'Read {count} pages',
    running: 'Running…',
    done: 'Done',
    failed: 'Failed',
    awaiting: 'Needs approval',
    resultToggle: 'Show result',
  },
  // Condensed activity group (Codex-like redesign) — the timed, collapsible work
  // block that wraps an assistant turn's reasoning + tool steps.
  resourceFields: {title: 'Title', name: 'Name', description: 'Description', content: 'Note content', text: 'Source text', url: 'URL', color: 'Color', emoji: 'Icon', parentId: 'Parent deck', archived: 'Archived', pinned: 'Pinned', status: 'Status', language: 'Language', tags: 'Tags', notebook: 'Notebook', source: 'Material', icon: 'Icon'},
  resourceKinds: {cards: 'Cards', decks: 'Decks', notes: 'Notes', artifacts: 'Studio artifacts', conversations: 'Conversations', reviews: 'Reviews'},
  activity: {
    completedSteps: 'Completed actions: {count}',
    results: 'Results: {count}',
    cardsCount: 'Cards: {count}',
    dueCount: 'Due: {count}',
    moreResults: 'Show {count} more',
    collapseResults: 'Show less',

    worked: 'Worked for {time}',
    working: 'Working…',
    workedSub: '<1s',
    workedSeconds: '{count}s',
    workedMinutes: '{m}m {s}s',
    workedHours: '{h}h {m}m',
    steps: 'Activity · {count}',
    step: '{count} step',
    appliedCreated: 'Created {count} cards in {deck} · open',
    appliedCreatedNodeck: 'Created {count} cards · open',
    appliedCreatedOne: 'Card created in {deck} · open',
    appliedCreatedOneNodeck: 'Card created · open',
    appliedEdited: 'Card updated · open',
  },
  // Confirm-before-write controls (Phase B) — a write/SRS tool pauses the turn
  // and asks for explicit human approval, rendered inside the pending tool card.
  confirm: {
    retainedResources: 'Preserved',
    notebookRetainedWork: 'Library sources, source-owned notes and completed study work, cards and conversations are preserved.',
    userQuoteEvidence: 'User-supplied quote; exact source text is not verified.',
    noCardEvidence: 'No source passage is attached to this card.',
    resourceDeleteWarning: 'The listed data will be deleted. Check the affected resources before confirming.',
    pendingTitle: 'Awaiting your confirmation',
    apply: 'Apply',
    reject: 'Reject',
    applied: 'Applied',
    rejected: 'Rejected',
    // Blast-radius summary shown above Apply so destructive writes are deliberate.
    willCreate: 'Will create {count} cards',
    willDelete: 'Will DELETE {count} cards — FSRS history lost',
    affectsSiblings: 'Affects other cards of this note',
    // Confirm previews (B4/C8): before/after diff rows + proposed content.
    changes: 'Proposed changes',
    proposed: 'New card content',
    // Batch create_card preview — per-card section heading.
    cardN: 'Card {n}',
    // Per-card confirm editor (batch create): include/exclude + inline edits +
    // a note to the agent.
    applyN: 'Apply ({count})',
    excludeCard: 'Exclude',
    includeCard: 'Include',
    feedbackPlaceholder: 'Optional note for the agent — what to change…',
    // One-card-at-a-time confirm wizard (batch create).
    cardOf: 'Card {n} of {total}',
    acceptCard: 'Accept',
    back: 'Back',
    acceptedBadge: 'Accepted',
    excludedBadge: 'Excluded',
    reviewJump: 'Open this card again',
    // Source provenance preview (NotebookLM M3) — the passages the new card(s)
    // will be linked to.
    provenanceTitle: 'Linked sources',
    provenanceRow: 'Source: {title}',
    provenanceRowPage: 'Source: {title}, p. {n}',
    // save_note proposal (Р14 / N3) — the note the agent proposes to save.
    noteTitle: 'Note',
  },
  // Source-passage citations (NotebookLM M2) — chips under a grounded answer.
  source: {
    open: 'Open in the reader',
    untitled: 'Source',
    page: 'p. {n}',
  },
  plan: {
    modules: '{count} modules',
  },
  // Errors surfaced in the stream
  errors: {
    generic: 'Something went wrong. Please try again.',
    disabled: 'Chat is disabled on the server.',
    turnInProgress: 'A reply is already running in this thread — wait for it to finish.',
  },
};

export default m;
