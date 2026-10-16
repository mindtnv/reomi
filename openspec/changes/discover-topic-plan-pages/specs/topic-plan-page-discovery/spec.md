# Spec Delta

## Purpose

Turn a documentation root on a topic-plan card into confirmed documentation sections, chosen by a cheap index and a per-module token budget, and fetch only the current module and the next one.

## ADDED Requirements

### Requirement: A docs root is a discovery seed
A suggested http(s) URL SHALL be a discovery seed, and SHALL NOT be ingested as the only module page, when its path is `/`, `/docs/`, or `/documentation/`, or when every path segment is a version label or one of those docs-root names. A version label is `stable`, `latest`, `next`, `current`, or a numeric version such as `v1`, `2.x`, `3.1`, or host label `v1-34`. A suggested URL that is a strict prefix of other same-host pages SHALL limit that module to that subtree. A leaf URL SHALL remain that page. The proposal SHALL NOT insert a notebook, plan, source, or card.

#### Scenario: Kubernetes docs root is a seed
- **WHEN** the plan suggestion for a module is `https://kubernetes.io/docs/`
- **THEN** that URL is a seed and is not stored as the module's only page

#### Scenario: A leaf page stays
- **WHEN** the plan suggestion is a leaf page with no child page in the index
- **THEN** discovery does not add other pages from that host in place of that URL

#### Scenario: Nothing is written before confirm
- **WHEN** discovery finishes for a plan card
- **THEN** the account's notebooks, sources, and cards are unchanged

### Requirement: The index is cheap and complete
Discovery SHALL build one index from `/llms.txt`, then `/llms-full.txt`, then `sitemap.xml`, then navigation links on that one seed page. An index entry SHALL carry the URL, the title, and the tree position, and MAY carry a same-line llms description. Sitemap URLs SHALL fill the tree when the sitemap is readable. Matching llms entries SHALL supply titles and descriptions. When the sitemap yields no in-scope URL, llms links SHALL be the tree. When neither yields an in-scope URL, navigation links from that one page SHALL be the tree, and no further HTML page SHALL be fetched. Building the index SHALL NOT call the model and SHALL NOT download candidate page bodies. Each llms file SHALL be read to at most 256 KiB. The sitemap read for one seed SHALL stop at 8 MiB or 20,000 `loc` entries. A sitemap index SHALL contribute at most 16 same-host children, skipping a child whose name is another locale.

#### Scenario: Sitemap fills the tree
- **WHEN** `/llms.txt` describes one workloads page and the sitemap lists the workloads and tasks pages
- **THEN** the index contains both subtrees, the workloads page keeps the llms title, and navigation links are not read

#### Scenario: Sitemap missing
- **WHEN** neither the sitemap nor an llms file yields an in-scope URL
- **THEN** the index is the links on that one seed page

#### Scenario: Off-host link
- **WHEN** an index link points at another host
- **THEN** that link is dropped and is not fetched

### Requirement: Discovery stays on one host, one language, and one version
Every index entry SHALL use the seed host and SHALL begin with the seed path prefix. A redirect that leaves that host or prefix SHALL drop the entry. The existing page-fetch SSRF guards SHALL apply. The draft locale is `en` or `ru`. When pages exist for that locale, only that locale SHALL remain. Otherwise English SHALL remain, including an unprefixed `/docs/` path. Other locale prefixes, including `/zh-cn/` and `/ru/` when the locale is English, SHALL be dropped. Version labels in the path and a host `v<major>-<minor>.docs.*` SHALL be detected. With no named version, discovery SHALL prefer `stable`, then `latest`, then `current`, then the highest numeric version, and SHALL use `next` only when nothing else remains. A named version SHALL win on the same host. A version on another host SHALL NOT be fetched. Entries that share a canonical URL SHALL be one page.

#### Scenario: English drops translations
- **WHEN** the draft locale is `en` and the same page exists under `/docs/` and `/zh-cn/docs/`
- **THEN** the index keeps the English page only

#### Scenario: Russian locale prefers Russian
- **WHEN** the draft locale is `ru` and both `/ru/docs/` and `/docs/` contain the page
- **THEN** the index keeps the `/ru/` page and drops the English duplicate

#### Scenario: Versioned host stays out
- **WHEN** the seed is `https://kubernetes.io/docs/` and the sitemap lists `https://v1-33.docs.kubernetes.io/docs/concepts/workloads/pods/`
- **THEN** that host is not fetched and its page is not indexed

### Requirement: Modules map to related subtrees within a token budget
Discovery SHALL score content subtrees by overlap between the module title and outcome and the subtree path, page titles, and any llms description. The primary subtree SHALL be the deepest matching subtree whose estimated tokens fit the module budget. Related subtrees SHALL be other content subtrees whose page titles share tokens with the primary subtree, added in score order while the remaining budget allows. A subtree that does not fit SHALL be replaced by child subtrees that fit, not by a silent page cutoff. Reference subtrees SHALL NOT be selected in bulk. Blog, tag, and index pages SHALL be excluded unless the module title or outcome names that class. A module with no surviving subtree SHALL be shown with no pages. Matching SHALL NOT call the model. The estimate SHALL use the llms description when present and otherwise a configurable per-page estimate. The module budget SHALL be a configurable token total. There SHALL be no page-count cap.

#### Scenario: Workloads includes the related tasks
- **WHEN** a Workloads module's concept pages and `/docs/tasks/run-application/` pages share title tokens, and both subtrees fit the token budget
- **THEN** the card offers both subtrees and does not offer an unrelated services subtree

#### Scenario: Budget blocks a related subtree
- **WHEN** the primary subtree fits the token budget and the related subtree does not
- **THEN** the card offers the primary subtree and omits the related subtree

#### Scenario: Reference is not bulk-included
- **WHEN** the index contains `/docs/reference/kubernetes-api/` and the module does not name that class
- **THEN** that reference subtree is not offered as a selected section

### Requirement: Linked reference pages only
After a selected page is fetched, a same-host link from that page into a reference subtree SHALL be added to the same module when the URL is in the index, passes the host, prefix, language, and version rules, and fits the remaining token budget. No other reference page SHALL be added. The added page SHALL follow the same ingest timing as its module.

#### Scenario: One linked API page
- **WHEN** a selected workloads page links to one Pod API reference page
- **THEN** that API page is added to the module and the rest of the API reference is not

#### Scenario: Unlinked reference page
- **WHEN** a reference page is in the index and no selected page links to it
- **THEN** it is not stored and not fetched

### Requirement: The user confirms sections before ingest
The plan card SHALL show each offered section with its page count and its estimated tokens. The user SHALL be able to drop a section, expand it, and drop individual pages. Reference subtrees SHALL be shown as not selected. Applying the card SHALL store only the pages still selected. Rejecting the card SHALL write no notebook, plan, source, or card. The chosen version label SHALL be stored on each created library source. An unversioned docs host SHALL store no numeric version. A versioned docs host `v1-34.docs.*` SHALL store `v1.34`.

#### Scenario: Section count is visible
- **WHEN** a module offers the workloads subtree
- **THEN** the confirm card shows that section, its page count, and its estimated tokens before anything is written

#### Scenario: Deselect a section
- **WHEN** the user drops the tasks section and confirms the workloads section
- **THEN** only the workloads pages are stored

#### Scenario: Reject
- **WHEN** the user rejects a card that lists sections
- **THEN** no notebook, plan, source, or card is written

### Requirement: Only the current and next module are fetched
Confirm SHALL store every selected page as a library source linked to its module. It SHALL fetch and extract page text only for the first module and the following module. Every later selected page SHALL be stored with status `planned` and SHALL NOT be fetched. The ingest worker SHALL NOT claim a `planned` source. When the learner opens a later module, that module and the following module SHALL be fetched and extracted. A page that fails SHALL remain an error on that source and SHALL NOT stop the others. A module whose sources are all `planned` SHALL be shown as planned, not as a failure. Flashcards, quizzes, and study guides SHALL NOT be created.

#### Scenario: Later modules stay planned
- **WHEN** the user confirms three modules
- **THEN** the first two modules are fetched and the third module's sources stay `planned`

#### Scenario: Reaching a module fetches the next one
- **WHEN** the learner opens the third module and a fourth module is still planned
- **THEN** the third and fourth modules are fetched and earlier planned pages are not fetched early

#### Scenario: One page fails
- **WHEN** one page in the current module fails ingest
- **THEN** the other pages in that module can still become ready

#### Scenario: Discovery fails closed
- **WHEN** both llms files, the sitemap, and the seed page cannot be read
- **THEN** the proposal still returns, the module has no sections, and no source is created
