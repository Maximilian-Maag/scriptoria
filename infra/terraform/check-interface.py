#!/usr/bin/env python3
"""The interface, checked rather than asserted.

Five implementations of one contract is a portability claim only while the five
agree about what the contract is. This reads the declarations out of each one and
fails when one has drifted: an implementation that needed a variable the others do
not ask for, or answered with an output the others do not produce, would be a
deployment that runs on that provider and not on the others.

What it compares:

  * the variables an implementation *requires* — the ones with no default. These are
    the caller's side of the contract, so they have to be identical everywhere;
  * the outputs, likewise, because the step after an apply is written once in the
    guide and an output that only one provider has would be a step only one
    provider takes;
  * the size classes, because the environments name a class and each implementation
    has to know what it means here.

A variable *with* a default may differ. A region, an image, an account model — those
are the provider's business, and requiring one of them everywhere would be a
contract no provider could satisfy.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
IMPLEMENTATIONS = ["linode", "aws", "gcp", "azure", "stackit"]
CLASSES = ["small", "medium", "large"]


def blocks(text, keyword):
    """Every `keyword "name" { ... }` block, brace-counted.

    Counted rather than matched to the first `}` because variable blocks contain
    nested blocks (validation), and stopping at the first brace would read half of
    one and miss whether it declared a default.
    """
    found = {}
    for match in re.finditer(rf'^{keyword}\s+"([^"]+)"\s*\{{', text, re.MULTILINE):
        index, depth = match.end() - 1, 0
        while index < len(text):
            if text[index] == "{":
                depth += 1
            elif text[index] == "}":
                depth -= 1
                if depth == 0:
                    break
            index += 1
        found[match.group(1)] = text[match.start():index]
    return found


def declared(directory):
    variables = blocks((directory / "variables.tf").read_text(), "variable")
    outputs = blocks((directory / "outputs.tf").read_text(), "output")

    required = {
        name
        for name, body in variables.items()
        if not re.search(r"^\s*default\s*=", body, re.MULTILINE)
    }
    optional = sorted(set(variables) - required)

    return required, optional, set(outputs)


def classes_in(main_tf):
    """The size classes an implementation actually maps.

    Read out of the mapping rather than trusted: a class the environments use and an
    implementation forgot is an apply that fails with "invalid index" at the moment
    somebody is trying to bring an environment up.
    """
    text = main_tf.read_text()
    mapping = re.search(r"sizes\s*=\s*\{(.*?)\n  \}", text, re.DOTALL)
    if not mapping:
        return set()
    return set(re.findall(r"^\s*(\w+)\s*=", mapping.group(1), re.MULTILINE))


def main():
    problems = []
    tables = {}

    for name in IMPLEMENTATIONS:
        directory = ROOT / name
        if not (directory / "variables.tf").exists():
            problems.append(f"{name}: no variables.tf — an implementation that is not there is not an implementation")
            continue

        required, optional, outputs = declared(directory)
        classes = classes_in(directory / "main.tf")
        tables[name] = (required, optional, outputs, classes)

    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1

    first = IMPLEMENTATIONS[0]
    reference_required, _, reference_outputs, reference_classes = tables[first]

    for name in IMPLEMENTATIONS[1:]:
        required, optional, outputs, classes = tables[name]

        if required != reference_required:
            for extra in sorted(required - reference_required):
                problems.append(f"{name}: requires '{extra}', which {first} does not — a caller would need a different tfvars file per provider")
            for missing in sorted(reference_required - required):
                problems.append(f"{name}: does not require '{missing}', which {first} does — the caller's side of the contract has to be the same")

        if outputs != reference_outputs:
            for extra in sorted(outputs - reference_outputs):
                problems.append(f"{name}: outputs '{extra}', which {first} does not")
            for missing in sorted(reference_outputs - outputs):
                problems.append(f"{name}: does not output '{missing}', which {first} does — the step after an apply is written once")

        for missing in sorted(set(CLASSES) - classes):
            problems.append(f"{name}: maps no '{missing}' machine, and the environments name that class")
        _ = optional

    if problems:
        print("the five implementations have drifted apart:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1

    print(
        f"  one contract, five implementations: {len(reference_required)} required variables, "
        f"{len(reference_outputs)} outputs, {len(reference_classes)} size classes"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
