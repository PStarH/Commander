from commander.advisor import TrajectoryAdvisor


def test_no_loop_on_different_tools():
    advisor = TrajectoryAdvisor(repeat_threshold=3, same_tool_threshold=4)
    history = [
        {"name": "search", "arguments": {"q": "a"}},
        {"name": "book", "arguments": {"id": 1}},
        {"name": "search", "arguments": {"q": "b"}},
    ]
    assert advisor.check(history) is None


def test_exact_repeat_loop():
    advisor = TrajectoryAdvisor(repeat_threshold=3, same_tool_threshold=4)
    history = [
        {"name": "search", "arguments": {"q": "foo"}},
        {"name": "search", "arguments": {"q": "foo"}},
        {"name": "search", "arguments": {"q": "foo"}},
    ]
    hint = advisor.check(history)
    assert hint is not None
    assert hint.pattern == "exact_repeat"
    assert "same tool call" in hint.message.lower() or "3 times" in hint.message


def test_same_tool_loop_with_different_args():
    advisor = TrajectoryAdvisor(repeat_threshold=3, same_tool_threshold=4)
    history = [
        {"name": "search", "arguments": {"q": "a"}},
        {"name": "search", "arguments": {"q": "b"}},
        {"name": "search", "arguments": {"q": "c"}},
        {"name": "search", "arguments": {"q": "d"}},
    ]
    hint = advisor.check(history)
    assert hint is not None
    assert hint.pattern == "same_tool_repeat"


def test_handles_object_tool_calls():
    class ToolCall:
        def __init__(self, name, arguments):
            self.name = name
            self.arguments = arguments

    advisor = TrajectoryAdvisor(repeat_threshold=2, same_tool_threshold=4)
    history = [ToolCall("x", {"a": 1}), ToolCall("x", {"a": 1})]
    hint = advisor.check(history)
    assert hint is not None
    assert hint.pattern == "exact_repeat"
