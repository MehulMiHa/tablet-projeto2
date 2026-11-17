"""Validation of raw V1 command acknowledgements, without device dependencies."""


def validate_acknowledgement(result):
    """Reject error values that some firmware returns inside the result field.

    The library raises RPC API errors, but a successful transport response can
    still contain values such as ["unknown_method"] instead of ["ok"].
    """
    if result is False:
        raise ValueError("O Rocky recusou o comando.")
    if isinstance(result, (int, float)) and result < 0:
        raise ValueError("O Rocky recusou o comando.")
    if isinstance(result, str):
        normalized = result.strip().lower().replace("_", " ").replace("-", " ")
        failure_prefixes = (
            "error", "fail", "unknown", "unsupported", "not support",
            "invalid", "command not", "method not", "not allowed", "busy", "timeout",
        )
        if normalized.startswith(failure_prefixes):
            raise ValueError("O Rocky recusou o comando: " + normalized[:100])
    elif isinstance(result, list):
        for item in result:
            validate_acknowledgement(item)
    elif isinstance(result, dict):
        if result.get("error") or result.get("success") is False:
            raise ValueError("O Rocky recusou o comando.")
        code = result.get("code")
        if isinstance(code, (int, float)) and code != 0:
            raise ValueError("O Rocky recusou o comando.")
        for key in ("result", "status"):
            if key in result:
                validate_acknowledgement(result[key])
    return result
