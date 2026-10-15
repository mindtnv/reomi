# Spec Delta

## Purpose

Turn one learning goal into an ordered notebook plan whose modules become library sources only after the user accepts them.

## ADDED Requirements

### Requirement: A goal yields an editable draft
An authenticated user with chat enabled SHALL be able to request an unsaved draft from a goal of 1 to 200 characters, an optional level of 1 to 80 characters, and a locale of `en` or `ru`. The draft SHALL contain 4 to 8 modules. Each module SHALL have a title of 1 to 120 characters, an outcome of 1 to 400 characters, prerequisites that refer only to earlier modules in that draft, and 0 to 4 http(s) URLs. The completion request SHALL treat the goal as data and SHALL name the requested locale for titles and outcomes. The draft request SHALL NOT create a notebook, plan, source, or card. Before the draft is returned, each suggested URL SHALL be checked with HEAD, then with GET when HEAD is not a success, through the existing page fetch and its SSRF guards. A URL that those guards reject, or that does not return a success status, SHALL be dropped. A module MAY come back with no URLs. The check SHALL NOT insert a source.

#### Scenario: Draft for a new topic
- **WHEN** chat is enabled and the user requests a draft for a non-empty goal
- **THEN** the response contains an ordered module draft and the account's notebooks, sources, and cards are unchanged

#### Scenario: Russian draft
- **WHEN** the draft request locale is `ru`
- **THEN** the completion request instructs the model to write titles and outcomes in Russian

#### Scenario: Dead suggested URL
- **WHEN** the model suggests one URL that answers successfully and one URL that does not
- **THEN** the draft contains only the successful URL and no source is created

#### Scenario: Private suggested URL
- **WHEN** the model suggests a URL the page fetch rejects as private
- **THEN** that URL is absent from the draft

#### Scenario: Invalid model output
- **WHEN** the model output does not satisfy the draft bounds
- **THEN** the response is a generation failure and no notebook, plan, source, or card is written

#### Scenario: Chat is off
- **WHEN** chat is disabled and the user requests a draft
- **THEN** the response is `ai_disabled`, no model call is made, and no notebook or plan is written

#### Scenario: Repeated draft
- **WHEN** chat is enabled, the AI cooldown is enabled, and the same user requests another draft within 30 seconds
- **THEN** the response is a cooldown error and the model is not called again

### Requirement: The user can save a hand-built plan without chat
A user SHALL be able to save a plan of 1 to 12 modules without requesting a draft. The goal SHALL be 1 to 200 characters. The level SHALL be omitted or 1 to 80 characters. Each module SHALL use the same title, outcome, prerequisite, and URL bounds as a draft. Modules with no URLs SHALL be valid. A save outside those bounds SHALL be rejected and SHALL NOT write. Chat being disabled SHALL NOT block a valid save.

#### Scenario: Blank plan while chat is off
- **WHEN** chat is disabled and the user saves one hand-entered module with no URLs
- **THEN** the plan is stored and no model call is made

#### Scenario: Too many modules
- **WHEN** the user saves 13 modules
- **THEN** the response is rejected and no plan is written

#### Scenario: Prerequisite points forward
- **WHEN** the user saves a module whose prerequisite is itself or a later module
- **THEN** the response is rejected and no plan is written

### Requirement: Saving creates one notebook plan
The first save for a new plan SHALL create one owned notebook and exactly one plan in the same successful result. That new notebook's title SHALL come from the goal. A later save SHALL NOT rename the notebook. A save that names an owned notebook SHALL attach the plan to that notebook. A notebook SHALL hold at most one plan. A later save SHALL replace the goal, level, and module list. A module whose existing id is included SHALL keep its source links. A module omitted from the save SHALL lose its links. Omitted modules SHALL NOT delete library sources or notebook memberships. A save SHALL NOT create cards.

#### Scenario: First save
- **WHEN** the user saves a valid draft and does not name an existing notebook
- **THEN** one new notebook and one plan exist, and the client is sent to that notebook's plan

#### Scenario: Second save keeps a module
- **WHEN** the user saves again and includes an existing module id
- **THEN** that module remains and its previously linked sources stay linked

#### Scenario: Second save drops a module
- **WHEN** the user saves again and omits a module that had a linked source
- **THEN** the module and its link are gone, and the library source and notebook membership remain

#### Scenario: Second plan for one notebook
- **WHEN** the user saves a new plan onto a notebook that already has a plan
- **THEN** the request is rejected and the stored plan is unchanged

#### Scenario: Foreign notebook
- **WHEN** the user saves a plan onto another user's notebook
- **THEN** the response is not found and no plan is written

### Requirement: Accepted URLs become that module's sources
An explicit action SHALL add the submitted URLs of one owned module in order. Each URL SHALL be normalized by trimming, requiring `http` or `https`, rejecting userinfo, lowercasing the scheme and host, and removing the fragment. For a matching owned URL source that is not deleting, the action SHALL link that source and attach it to the notebook when it is not already attached, and SHALL NOT insert another source. Otherwise the action SHALL create one URL library item through the existing ingest path and link it. The action SHALL stop before a library cap or a notebook source cap would be exceeded. URLs already processed in that action SHALL remain. The response SHALL identify each URL as linked, created, or rejected with a machine code. A later ingest failure SHALL remain the source's existing error state and SHALL NOT remove the module link. The action SHALL NOT create cards and SHALL NOT fetch the URL before the source row exists.

#### Scenario: Reuse an owned page
- **WHEN** the user adds a URL that matches an owned URL source that is not deleting
- **THEN** no additional source row is created, the source is attached to the plan's notebook, and the module lists it

#### Scenario: New page
- **WHEN** the user adds a new http(s) URL and both caps allow it
- **THEN** one URL source is created, existing ingest starts, and the module lists that source

#### Scenario: Cap stops the rest of the batch
- **WHEN** the next URL in the batch would exceed the library cap or the notebook source cap
- **THEN** that URL and the URLs after it are not created, earlier URLs from the same action remain, and the response names the cap code

#### Scenario: Fetch fails after add
- **WHEN** an added URL later fails ingest
- **THEN** the source shows the existing ingest error and the module still lists it

### Requirement: Plan status is derived and opens the reader
A module with no linked sources SHALL be empty. A module whose linked sources are still in a non-terminal ingest state SHALL be ingesting. A module with at least one source the existing reader can open SHALL be readable. The plan view SHALL open that source in the existing reader. Status SHALL NOT be stored as a separate completion flag, and the plan SHALL NOT mark a module mastered.

#### Scenario: Page still parsing
- **WHEN** a linked source is still parsing
- **THEN** the module is shown as ingesting and is not shown as readable

#### Scenario: Open a readable page
- **WHEN** the user opens a linked source the reader can open
- **THEN** the existing reader opens that source and no card is created

### Requirement: Plans stay isolated and follow ownership
Reading or changing a plan SHALL require the owning user. Deleting the notebook SHALL delete the plan and its modules. Deleting a linked source SHALL remove that link and SHALL leave the plan and the other links in place. No plan route SHALL create, grade, suspend, or delete a card.

#### Scenario: Another user
- **WHEN** a different user reads the plan, saves modules, or adds sources for it
- **THEN** the response is not found and no plan, source, or card is created for that user

#### Scenario: Delete the notebook
- **WHEN** the owner deletes the notebook
- **THEN** the plan and modules are deleted and the library sources remain

#### Scenario: Delete a linked source
- **WHEN** the owner deletes a source linked from a module
- **THEN** the module remains without that link

### Requirement: The plan is reachable before a deck exists
The welcome screen SHALL offer a learn-a-topic action together with the existing deck, library, and chat actions. The empty notebooks screen and a notebook with no plan SHALL offer the same flow. The flow SHALL let the user generate a draft when chat is enabled and SHALL let the user enter modules by hand when it is not. Saving a new plan SHALL open that notebook's plan.

#### Scenario: New account
- **WHEN** an authenticated account with no decks opens the welcome screen
- **THEN** the learn-a-topic action is available and the existing deck, library, and chat actions remain

#### Scenario: Notebook without a plan
- **WHEN** the owner opens a notebook that has no plan
- **THEN** the notebook offers the plan flow and does not create a plan until the user saves one
