// Library (L1) — the /library material-store screen: header (search / filters /
// sort / view toggle / add menu), the "Continue reading" shelf, the cover grid /
// list rows (kind placeholders — no covers yet), the details panel (metadata edit
// + attach-to-notebook + delete), and the upload / url / text dialogs + toasts.
//
// `status.*` (ingest lifecycle + machine error codes) is shared with the
// notebooks dict — but each namespace owns its own copy so the i18n-parity test
// can enforce both independently. Every key MUST exist in BOTH locales.

const library = {
  capture: { loading: 'Opening your saved passage…', unavailable: 'This capture is unavailable or its source has changed. Open the material and select a passage, or sign in to the account connected to the extension.',
    pageHint: 'Your page is saved. This draft starts with its opening passage; you can select another passage in the material.', selectionHint: 'Your selected passage is saved in the library. Review the card and choose a deck before saving.' },
  documentation: {
    schedule: 'Auto-update', scheduleFor: 'Auto-update: {title}',
    schedules: { off: 'Off', daily: 'Every day', weekly: 'Every week' },
    checking: 'Checking for updates…', nextCheck: 'Next check: {date}', lastChecked: 'Checked: {date}',
    schedulePaused: 'Auto-update continues after you resume the import.',
    changes: 'Added {added} · Updated {updated} · Unchanged {unchanged}',
    add: 'Connect documentation', description: 'Choose website sections. Each page becomes a separate library material.',
    connected: 'Connected documentation', url: 'Documentation URL', language: 'Page language',
    scopeHint: 'We look within the documentation. Translations, other websites and old versions are not added automatically.',
    detectedRoot: 'Website section to import', folderName: 'Folder name', sections: 'Sections', allSections: 'All sections',
    discovered: '{count} pages found', selection: '{count} selected. {added} new materials, {available} places available.',
    chooseSmaller: 'Choose a smaller section, or expand a branch and exclude parts you do not need.',
    findSections: 'Find sections', discovering: 'Finding sections…', import: 'Add to library', starting: 'Starting import…', back: 'Back',
    openFolder: 'Open folder', checkUpdates: 'Check for updates', cancelImport: 'Stop import', resume: 'Resume import',
    disconnect: 'Disconnect documentation', disconnectHint: 'Stop this connection? Imported pages, folders, notes and cards will remain in your library.',
    progress: '{done} of {total} pages', importProgress: 'Import progress', failures: '{count} need attention', failureDetails: 'Pages with errors',
    failed: 'Could not complete the action. Try again.', loadFailed: 'Could not load connected documentation.',
    states: { draft: 'Preview', queued: 'Queued', running: 'Importing', completed: 'Imported', attention: 'Needs attention', cancelled: 'Stopped' },
    errors: {
      documentation_unavailable: 'Documentation is unavailable. Saved materials have not changed.',
      documentation_empty: 'No pages found. Try the URL of a documentation section.',
      documentation_preview_expired: 'This preview expired. Go back and find sections again.',
      documentation_already_connected: 'This documentation is already connected. Use Check for updates.',
      documentation_busy: 'An import is already running. Wait for it to finish or stop it.',
      documentation_folder_missing: 'The import folder was deleted. Saved materials remain in the library.',
      library_full: 'Not enough library capacity. Choose fewer sections or free up space.',
      folder_limit: 'The folder limit has been reached.', folder_depth_limit: 'Too many nested sections. Choose a narrower documentation URL.',
      invalid_sections: 'Choose at least one available section.', source_busy: 'This material is already being processed. Check again later.',
      fetch_failed: 'Could not fetch this page. Previously saved text remains available.', empty_source: 'No readable text found on the page.',
      remote_missing: 'This page is no longer in the index. Its saved material remains in the library.',
      documentation_limit: 'The connected documentation limit has been reached.', documentation_preview_limit: 'Too many previews. Try again in a few minutes.',
    },
  },
  saved: {
    description: 'Notes and documents saved while working with your sources. They stay here even if a source is deleted.',
    unavailableFilter: 'Only work with an unavailable source',
    unavailableHint: 'Show retained work whose original source is no longer in your library.',
    back: 'Back to library',
  },
  folders: {
    "emptyTitle": "This folder is empty",
    "emptyUnfiled": "No unfiled materials",
    "emptyHint": "Add a material or move one here from your library.",
    "emptyAdd": "Add a file",
    "title": "Folders",
    "navigation": "Library folders",
    "breadcrumbs": "Folder path",
    "all": "All materials",
    "unfiled": "Unfiled",
    "create": "New folder",
    "name": "Folder name",
    "rename": "Rename",
    "move": "Move",
    "moveFolder": "Move folder",
    "delete": "Delete folder",
    "deleteDestination": "Where should the materials go?",
    "deletePreview": "{folders} folders and {materials} materials. Materials will be kept.",
    "deleteConfirm": "Delete “{name}” and its {folders} folders? Move {materials} materials to “{destination}”. Source files, cards and notebook links will be kept.",
    "browser": "From browser",
    "collapse": "Collapse {name}",
    "expand": "Expand {name}",
    "subtreeCount": "{count} materials, including subfolders",
    "selectVisible": "Select all shown",
    "selected": "Selected: {count}",
    "clear": "Clear selection",
    "selectMaterial": "Select material: {title}",
    "moveMaterial": "Move material: {title}",
    "moveMaterials": "Move {count} materials",
    "failed": "Could not update library folders. Please retry.",
    "retry": "Retry",
    "errors": {
        "folder_changed": "This folder changed. Refresh it and try again.",
        "folder_name_exists": "A folder with this name already exists here.",
        "folder_cycle": "Choose a destination outside this folder and its children.",
        "folder_limit": "The folder count or nesting limit has been reached.",
        "folder_not_found": "The destination folder is no longer available. Choose another folder.",
        "source_not_found": "Some selected materials are no longer available. Refresh the list.",
        "invalid_folder_name": "Enter a folder name between 1 and 100 characters."
    }
},
  title: 'Library',
  subtitle: 'Your books, articles, and notes.',

  // ── Header ────────────────────────────────────────────────────────────────────
  header: {
    filters: 'Filters',
    formatLabel: 'Format',
    readingLabel: 'Reading',
    searchPlaceholder: 'Search by title or author…',
    add: 'Add',
    addFiles: 'Files (PDF / EPUB)',
    addUrl: 'Web page',
    addText: 'Paste text',
    viewGrid: 'Grid view',
    viewList: 'List view',
    // Sort options.
    sortLabel: 'Sort',
    sortAdded: 'Recently added',
    sortTitle: 'Title',
    sortLastRead: 'Last read',
    // Kind filter chips.
    kindAll: 'All',
    kindPdf: 'PDF',
    kindEpub: 'EPUB',
    kindUrl: 'URL',
    kindText: 'Text',
    kindYoutube: 'YouTube',
    // Reading-status filter chips.
    readingAll: 'Any status',
    readingUnread: 'Unread',
    readingReading: 'Reading',
    readingFinished: 'Finished',
    // Shelf + tag filters.
    shelfUnattached: 'Not in notebooks',
    tagLabel: 'Tag',
    tagAll: 'All tags',
  },

  // ── Search mode (title vs content) ────────────────────────────────────────────
  search: {
    byTitle: 'By title',
    byContent: 'By content',
    contentPlaceholder: 'Search inside your library…',
    typeMore: 'Type at least 3 characters to search inside your books.',
    disabled: 'Content search is unavailable without indexing.',
    noResults: 'Nothing found in your library for this query.',
    hitPage: 'p. {page}',
    hitChunk: 'fragment {pos}',
  },

  // ── "Continue reading" shelf ──────────────────────────────────────────────────
  shelf: {
    continueReading: 'Continue reading',
    page: 'p. {page} of {total}',
    percent: '{percent}%',
  },

  // ── Item card / list row ──────────────────────────────────────────────────────
  item: {
    actionsFor: 'Actions for {title}',
    move: 'Move to folder',
    details: 'Details',
    untitled: 'Untitled',
    notebooks: '{count} notebooks',
    notebooksOne: '1 notebook',
    cards: '{count} cards',
    cardsOne: '1 card',
    indexingDisabled: 'Indexing off',
    open: 'Open',
    menu: 'More actions',
  },

  // ── Empty state ───────────────────────────────────────────────────────────────
  empty: {
    title: 'Your library is empty',
    hint: 'Upload a book or article to read it, mark it up, turn it into cards, and ground notebook chats on it.',
    cta: 'Add your first book',
    // Shown when a filter/search yields nothing.
    noResults: 'Nothing matches your filters.',
    clearFilters: 'Clear filters',
  },

  // ── Add dialogs ───────────────────────────────────────────────────────────────
  add: {
    urlTitle: 'Add a web page',
    textTitle: 'Add text',
    titleLabel: 'Title',
    titlePlaceholder: 'Material title',
    urlLabel: 'URL',
    urlPlaceholder: 'https://…',
    textLabel: 'Text',
    textPlaceholder: 'Paste the text to read and index…',
    submit: 'Add',
    adding: 'Adding…',
    failed: 'Could not add the material. Please try again.',
    // File upload queue.
    uploadingFile: 'Uploading {name}…',
    uploadProgress: '{done} of {total}',
    dropHint: 'Drop PDF or EPUB files to add them',
    fileHint: 'PDF or EPUB, up to {mb} MB.',
  },

  // ── Details panel (click an item) ─────────────────────────────────────────────
  details: {
    title: 'Details',
    author: 'Author',
    authorPlaceholder: 'Author or edition',
    tags: 'Tags',
    tagsPlaceholder: 'Add a tag…',
    addTag: 'Add',
    readingStatus: 'Reading status',
    notebooks: 'In notebooks',
    notebooksEmpty: 'Not in any notebook yet.',
    noCards: 'No cards from this material yet.',
    cardsCount: '{count} cards',
    // Actions.
    read: 'Read',
    rename: 'Rename',
    editAuthor: 'Edit author',
    addToNotebook: 'Add to notebook…',
    delete: 'Delete from library',
    close: 'Close',
    // Add-to-notebook picker.
    pickNotebook: 'Add to a notebook',
    pickNotebookEmpty: 'Create a notebook first.',
    alreadyIn: 'Already added',
    addToPicked: 'Add ({count})',
    addedToNotebook: 'Added to the notebook.',
    // Rename dialog.
    renameTitle: 'Rename material',
    renameLabel: 'Title',
    authorTitle: 'Edit author',
    authorLabel: 'Author',
    // Save feedback.
    saved: 'Saved',
    saveFailed: 'Could not save. Try again.',
  },

  // ── Delete confirm — must name the consequences (detach + card tombstones) ────
  delete: {
    title: 'Delete from library?',
    // Used when the material is attached to one or more notebooks.
    messageAttached:
      'This material will be detached from {count} notebooks. Saved study notes, completed study documents and quizzes, attempts, cards and conversations are preserved. The source file, highlights, annotation comments and ink are removed; source links become unavailable. This cannot be undone.',
    // Used when the material is in no notebook.
    message:
      'Saved study notes, completed study documents and quizzes, attempts, cards and conversations are preserved. The source file, highlights, annotation comments and ink are removed; source links become unavailable. This cannot be undone.',
    confirm: 'Delete',
  },

  // ── Detach (from a notebook — used in the workspace) ──────────────────────────
  detach: {
    title: 'Remove from notebook?',
    message: 'The material stays in your library — only its link to this notebook is removed.',
    confirm: 'Remove',
  },

  // ── Reingest (re-run parsing + indexing) ──────────────────────────────────────
  reingest: {
    action: 'Reindex',
    title: 'Reindex this material?',
    message: 'The material will be re-parsed and re-indexed. Its highlights, notes and ink stay; chat is briefly unavailable until indexing finishes.',
    messageUrl: 'The page will be re-fetched and re-indexed. Your highlights, notes and ink stay; chat is briefly unavailable until indexing finishes.',
    confirm: 'Reindex',
    started: 'Reindexing started.',
    failed: 'Could not reindex. Try again.',
  },

  // ── Duplicate-on-upload dialog ────────────────────────────────────────────────
  duplicate: {
    title: 'Already in your library',
    message: '“{title}” is already in your library.',
    open: 'Open it',
    cancel: 'Cancel',
  },

  // ── Toasts ────────────────────────────────────────────────────────────────────
  toast: {
    libraryFull: 'You\'ve reached your library limit.',
    uploadFailed: 'Upload failed. Please try again.',
    unsupported: 'Unsupported file type. Use PDF or EPUB.',
    deleted: 'Removed from your library.',
    detached: 'Removed from the notebook.',
  },

  // ── Status badge + machine error codes (errorCode → status.<code>) ────────────
  status: {
    indexWaiting: 'Text is available for reading and source-based study. Semantic search will be available after indexing.',
    readable: 'Available to read',
    pending: 'Queued',
    parsing: 'Parsing…',
    indexing: 'Indexing…',
    ready: 'Ready',
    error: 'Failed',
    deleting: 'Removing…',
    too_large: 'File is too large.',
    too_many_chunks: 'Material is too long to index.',
    index_failed: 'AI indexing failed. The file is available to read.',
    parse_failed: 'Could not read this material.',
    fetch_failed: 'Could not fetch this URL.',
    unsupported_mime: 'Unsupported file type.',
    empty_source: 'No readable text found.',
    no_subtitles: 'This video has no subtitles in the content language, Russian, or English.',
    video_unavailable: 'This video is private, deleted, or unavailable.',
  },

  // ── Workspace integration (attach picker + detach in the notebook) ────────────
  workspace: {
    attachFromLibrary: 'Add from library',
    attachTitle: 'Add from your library',
    attachSearch: 'Search your library…',
    attachEmpty: 'Your library is empty.',
    attachNoResults: 'Nothing matches.',
    attachConfirm: 'Add ({count})',
    detach: 'Remove from notebook',
    detachFailed: 'Could not remove the material.',
    openInLibrary: 'Read in library',
  },

  // ── Full-screen reader (/library/[id]) ────────────────────────────────────────
  reader: {
    indexError: 'Indexing unavailable',
    unavailable: 'Text is unavailable',
    unavailableHint: 'Processing failed. Open the material details to check the source.',
    preparing: 'Preparing your material',

    back: 'Library',
    loading: 'Loading…',
    notFound: 'This material is no longer in your library.',
    details: 'Details',
    // Table of contents.
    toc: 'Contents',
    tocClose: 'Close',
    tocEmpty: 'No table of contents.',
    // «Спросить» handoff into a notebook.
    handoffPick: 'Ask in a notebook',
    handoffEmpty: 'Create a notebook first.',
    handoffNewNotebook: 'New notebook',
    handoffFailed: 'Could not open a notebook chat. Try again.',
    // Cards badge + drawer (L4 §8.4).
    cardsBadge: '{n} cards',
    cardsTitle: 'Cards from this source',
    cardsEmpty: 'No cards yet.',
    // Markup export (L4 §8.4) — Markdown section labels.
    exportPage: 'Page',
    exportInk: '[ink]',
    exportCards: '{n} cards created from this source',
    exportDone: 'Markup exported.',
  },

  // ── Citation viewer (notebook chat [src:] click) ──────────────────────────────
  viewer: {
    openInLibrary: 'Open in library',
    close: 'Close',
  },
};

export default library;
