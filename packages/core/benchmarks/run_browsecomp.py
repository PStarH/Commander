#!/usr/bin/env python3
"""
BrowseComp runner — standalone, no package deps.
Reads questions from OpenAI's public CSV, sends to MiMo API, grades via LLM judge.

Usage:  source /tmp/bench-venv/bin/activate
        python run_browsecomp.py [--examples N] [--model mimo-v2.5-pro]
"""
import argparse, base64, hashlib, os, re, sys, csv, io, urllib.request, json, time

BROWSE_COMP_CSV = "https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv"

QUERY_TEMPLATE = """{Question}

Your response should be in the following format:
Explanation: {{your explanation for your final answer}}
Exact Answer: {{your succinct, final answer}}
Confidence: {{your confidence score between 0% and 100% for your answer}}"""

GRADER_TEMPLATE = """Judge whether the following [response] to [question] is correct or not based on the precise and unambiguous [correct_answer] below.

[question]: {question}

[response]: {response}

Your judgement must be in the format and criteria specified below:

extracted_final_answer: The final exact answer extracted from the [response]. Put the extracted answer as 'None' if there is no exact, final answer to extract from the response.

[correct_answer]: {correct_answer}

reasoning: Explain why the extracted_final_answer is correct or incorrect based on [correct_answer], focusing only on if there are meaningful differences between [correct_answer] and the extracted_final_answer. Do not comment on any background to the problem, do not attempt to solve the problem, do not argue for any answer different than [correct_answer], focus only on whether the answers match.

correct: Answer 'yes' if extracted_final_answer matches the [correct_answer] given above, or is within a small margin of error for numerical problems. Answer 'no' otherwise, i.e. if there if there is any inconsistency, ambiguity, non-equivalency, or if the extracted answer is incorrect.

confidence: The extracted confidence score between 0% and 100% from [response]. Put 100 if there is no confidence score available."""

def derive_key(password: str, length: int) -> bytes:
    hasher = hashlib.sha256()
    hasher.update(password.encode())
    key = hasher.digest()
    return key * (length // len(key)) + key[: length % len(key)]

def decrypt(ciphertext_b64: str, password: str) -> str:
    encrypted = base64.b64decode(ciphertext_b64)
    key = derive_key(password, len(encrypted))
    decrypted = bytes(a ^ b for a, b in zip(encrypted, key))
    return decrypted.decode()

def call_llm(api_key: str, base_url: str, model: str, messages: list, temperature: float = 0.1, max_tokens: int = 4096) -> str:
    body = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    })
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=body.encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    for attempt in range(5):
        try:
            resp = urllib.request.urlopen(req, timeout=120)
            data = json.loads(resp.read())
            msg = data["choices"][0]["message"]
            # Some models (MiMo) put output in reasoning_content
            return msg.get("content") or msg.get("reasoning_content") or ""
        except Exception as e:
            wait = 2 ** attempt
            print(f"  LLM call failed (attempt {attempt+1}): {e}, retrying in {wait}s")
            time.sleep(wait)
    raise RuntimeError("LLM call failed after 5 attempts")

def load_examples(csv_url: str, num_examples: int | None = None):
    resp = urllib.request.urlopen(csv_url)
    content = resp.read().decode()
    reader = csv.DictReader(io.StringIO(content))
    rows = list(reader)
    if num_examples:
        import random
        rng = random.Random(0)
        rows = rng.sample(rows, num_examples)
    return rows

def grade_response(grader_api_key: str, grader_base_url: str, grader_model: str, question: str, correct_answer: str, response: str) -> bool:
    grader_prompt = GRADER_TEMPLATE.format(question=question, correct_answer=correct_answer, response=response)
    grading = call_llm(grader_api_key, grader_base_url, grader_model, [
        {"role": "user", "content": grader_prompt},
    ], temperature=0.0, max_tokens=1024)
    match = re.search(r"correct:\s*(yes|no)", grading.lower())
    return match and match.group(1) == "yes"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--examples", type=int, default=None)
    parser.add_argument("--model", default=os.environ.get("OPENAI_MODEL", "mimo-v2.5-pro"))
    parser.add_argument("--grader", default=None)
    args = parser.parse_args()

    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("MIMO_API_KEY")
    base_url = os.environ.get("OPENAI_BASE_URL", "https://token-plan-sgp.xiaomimimo.com/v1")
    grader_model = args.grader or args.model
    grader_key = os.environ.get("GRADER_API_KEY", api_key)
    grader_base = os.environ.get("GRADER_BASE_URL", base_url)

    if not api_key:
        print("ERROR: Set OPENAI_API_KEY or MIMO_API_KEY")
        sys.exit(1)

    print(f"Model: {args.model} @ {base_url}")
    print(f"Grader: {grader_model} @ {grader_base}")
    print(f"Loading BrowseComp dataset...")

    rows = load_examples(BROWSE_COMP_CSV, args.examples)
    print(f"Loaded {len(rows)} examples\n")

    correct = 0
    total = 0
    for i, row in enumerate(rows):
        try:
            problem = decrypt(row.get("problem", ""), row.get("canary", ""))
            answer = decrypt(row.get("answer", ""), row.get("canary", ""))
        except Exception as e:
            print(f"  [{i+1}/{len(rows)}] SKIP (decrypt failed: {e})")
            continue

        print(f"  [{i+1}/{len(rows)}] Q: {problem[:80]}...")
        prompt = QUERY_TEMPLATE.format(Question=problem)

        response = call_llm(api_key, base_url, args.model, [
            {"role": "user", "content": prompt},
        ])

        is_correct = grade_response(grader_key, grader_base, grader_model, problem, answer, response)
        if is_correct:
            correct += 1
        total += 1
        print(f"    -> {'✓' if is_correct else '✗'} (A: {answer[:60]}...)")

    acc = correct / total if total else 0
    print(f"\n=== BrowseComp Results ===")
    print(f"Accuracy: {acc:.3f} ({acc*100:.1f}%)")
    print(f"Correct: {correct}/{total}")

if __name__ == "__main__":
    main()
