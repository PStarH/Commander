"""Tests for knowledge base endpoints."""

from __future__ import annotations

import json

import httpx
import respx

from commander import CommanderClient


class TestKnowledgeDocuments:
    async def test_upload_document(self, mock_api: respx.MockRouter) -> None:
        def check_body(request: httpx.Request) -> httpx.Response:
            data = json.loads(request.content)
            assert data["content"] == "doc content"
            assert data["name"] == "doc.md"
            assert data["type"] == "markdown"
            assert data["tags"] == ["tag1"]
            return httpx.Response(
                201,
                json={
                    "document": {
                        "id": "doc_1",
                        "name": "doc.md",
                        "type": "markdown",
                        "content": "doc content",
                        "tags": ["tag1"],
                        "status": "indexed",
                        "chunk_count": 2,
                    }
                },
            )

        mock_api.post("/api/knowledge/documents").mock(side_effect=check_body)
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                doc = await client.upload_document(
                    content="doc content",
                    name="doc.md",
                    type="markdown",
                    tags=["tag1"],
                )
        assert doc.id == "doc_1"
        assert doc.status == "indexed"
        assert doc.chunk_count == 2

    async def test_list_documents(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/knowledge/documents").respond(
            200,
            json={
                "documents": [
                    {
                        "id": "doc_1",
                        "name": "doc.md",
                        "type": "markdown",
                        "status": "indexed",
                    }
                ],
                "total": 1,
                "page": 1,
                "limit": 20,
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.list_documents(page=1, limit=20)
        assert result.total == 1
        assert result.documents[0].id == "doc_1"

    async def test_get_document(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/knowledge/documents/doc_1").respond(
            200, json={"id": "doc_1", "name": "doc.md", "type": "markdown"}
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                doc = await client.get_document("doc_1")
        assert doc.id == "doc_1"

    async def test_delete_document(self, mock_api: respx.MockRouter) -> None:
        mock_api.delete("/api/knowledge/documents/doc_1").respond(204)
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                await client.delete_document("doc_1")


class TestKnowledgeSearch:
    async def test_search_knowledge(self, mock_api: respx.MockRouter) -> None:
        def check_body(request: httpx.Request) -> httpx.Response:
            data = json.loads(request.content)
            assert data["query"] == "query"
            assert data["topK"] == 5
            assert data["docIds"] == ["doc_1"]
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "document_id": "doc_1",
                            "chunk_id": "chunk_1",
                            "score": 0.95,
                            "content": "relevant",
                        }
                    ],
                    "total": 1,
                },
            )

        mock_api.post("/api/knowledge/search").mock(side_effect=check_body)
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.search_knowledge(
                    "query", top_k=5, doc_ids=["doc_1"]
                )
        assert result.total == 1
        assert result.results[0].score == 0.95

    async def test_rag_query(self, mock_api: respx.MockRouter) -> None:
        mock_api.post("/api/knowledge/query").respond(
            200,
            json={
                "query": "question",
                "context": "relevant context",
                "sources": [
                    {
                        "document_id": "doc_1",
                        "chunk_id": "chunk_1",
                        "score": 0.9,
                        "content": "source",
                    }
                ],
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                result = await client.rag_query("question", top_k=3)
        assert result.query == "question"
        assert result.context == "relevant context"
        assert len(result.sources) == 1

    async def test_knowledge_stats(self, mock_api: respx.MockRouter) -> None:
        mock_api.get("/api/knowledge/stats").respond(
            200,
            json={
                "total_documents": 10,
                "total_chunks": 50,
                "total_size_bytes": 1024,
            },
        )
        async with CommanderClient(api_key="test") as client:
            async with mock_api:
                stats = await client.knowledge_stats()
        assert stats.total_documents == 10
        assert stats.total_chunks == 50
