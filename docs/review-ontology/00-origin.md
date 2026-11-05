# Origin: what a senior reviewer does that the bot doesn't

Joe Black · November 4, 2026

These are my notes from a conversation with an agent about ai-review-bot, dictated and lightly
copy-edited. They are the problem statement the rest of this folder answers. The architecture
is described in [how-it-works.md](../how-it-works.md).

## The question

I was asking whether our agent-based approach to code review takes into account the things a
human reviewer just does, because it's understood or second nature for a senior engineer.

## 1. Triaging the complexity of a PR

Right now we triage by lines of code, and not even lines of code, just lines of text. That's
about the crudest metric you can use to judge the complexity of a PR. A senior engineer looks
at it differently. They look at:

- What files are involved?
- How many files?
- How much of each of those files?
- What are those files?
- Are they binary files?
- Are they text files for specs?
- Are they HTML artifacts?
- Are they config files?
- Are they Dockerfiles?
- Are they shell scripts?
- Are they documentation?
- Are they Markdown specs or plans?
- Are they code?

If they're code, what kind of code is it?

- Is it the code for a module?
- Is it object-oriented code?
- Is it a library, like a utility library with a bunch of top-level functions?
- Is it a set of database models, object-oriented, for an ORM?
- Is it a set of controllers or views for an API server?
- Is it an object-oriented abstraction for a component used in an authentication system?

From that mix of files, their types and their content, a senior engineer gets a bird's-eye
sense of the complexity, especially once they've read the description and understand the
context, the ticket, or whatever else is behind it.

I don't think an agent can necessarily do this. We have to teach it, and I don't think we
have. How do we do that?

## 2. Pattern matching in the diff

When a senior engineer reads a diff, a lot of pattern matching is going on that we take for
granted. It's much harder for an agent.

Something as simple as moving a function from one file to another is obvious to a senior
engineer seeing it visually: "OK, this got moved from there to there." The surrounding
context makes it clear, especially if you check the PR out locally and have it in your IDE.
You can see that before the move, every reference to the function came from outside its file,
and they all came from one other file. Moving the function to that file means it no longer
has to be imported. All its callers are in one place, so it keeps everything local, which is
good for cohesion and locality.

I'm not sure how to program that into a model. A model sees that this many lines were
deleted from one file and this many were added to another. It may not connect the two,
especially if the files aren't next to each other in the PR. It sees a function deleted and a
function added. They may have the same name, or the function may have been renamed, which is
common when you move things: a name that made sense in the old module may not in the new one.
A senior engineer gets the connection right away, even with the rename. A model has no idea.

The two readings get completely different treatment. The senior engineer understands the
function was moved for cohesion, which reduces the overall complexity of the package. Maybe it
was the last thing left in that file, and now the file is gone.

In that case you don't need to review the moved function. It was probably reviewed already,
possibly years ago. What you need to review is:

- every place in the codebase that referenced the old location is updated, so nothing still
  imports it from the old spot
- each of those references is assessed on its own: should it be updated, or dropped?
- wherever its tests are, they import it from the right place
- if the tests live in a module named after the old module, they may need to move too
- any mocks may need updating

If the model just sees "this many lines deleted here, this many added there", it treats the
function as new code and reviews it as though it had never been seen. It loses all the
context the code had, including the git history of the file it came from. That's annoying
for the author, and worse, it skips every check that actually matters. And this is one simple
example out of probably countless things code review involves.

## What I'm asking for

For the first case: how do I teach a model to understand the relationships and context of
each file, its contents, and the connections between files, semantically and symbolically,
across all kinds of contexts? One context is judging a PR's complexity to pick the right model
tier, which Tier 1 and Tier 2 agents to dispatch, and what model and effort each one gets.

For the second case: I need an exhaustive master list of things like the move, the things a
model has to detect to give useful feedback at the level of a senior engineer. For each one,
not just the pattern but what it means and what has to be checked.

For the move, you want to work out why it moved. Maybe the PR explains it, or maybe you're
expected to infer it. Maybe it was the last member of a file being closed out. Maybe it was a
refactor for cohesion and simplicity. Maybe it was part of a dead-code cleanup where a lot got
deleted and what remained was relocated. Once you have the context (what happened, why, and
anything from the ticket), you check:

- all the old references are updated
- any interface change is acceptable, especially on a public interface
- the tests were relocated
- any mocks were relocated
- any config files pointing at an import path are updated

And if the code touches authentication, or untrusted input from users or the public (say, an
API endpoint receiving untrusted JSON payloads), there's a completely different security
checklist on top.

I want to build a catalog of all of this: a corpus of training material that doubles as an
eval set, so I can check that the review tool recognizes patterns, understands relationships,
gathers the full context around an operation, judges it by the right criteria, and works at
the level of a senior engineer reviewing a PR. That includes the ontology, the patterns and
relationships, how context gets built, and the semantic and symbol-based searching you'd
normally do in an IDE like VS Code, or with tree-sitter, LSPs, Serena and Graphify.
