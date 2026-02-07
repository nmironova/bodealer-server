import pytest
import requests

# ----- FIXTURES -----
@pytest.fixture(scope="session")
def constants():
    constants = {
        "root_url": "http://127.0.0.1:3000",
    }
    return constants

@pytest.fixture
def all_tasks(constants):
    response = requests.get(f"{constants['root_url']}/tasks")
    tasks = response.json().get("tasks", [])
    return tasks

@pytest.fixture()
def first_task(all_tasks):
    return all_tasks[0]

@pytest.fixture()
def new_task_responce(constants):
    new_task_body = {
        "name": "Test Task",
        "boardsNumber": 1,
    }
    response = requests.post(f"{constants['root_url']}/tasks", json=new_task_body)
    yield response
    # Cleanup: delete the created task
    created_task_id = response.json().get("id")
    if created_task_id:
        requests.delete(f"{constants['root_url']}/tasks/{created_task_id}")

@pytest.fixture()
def new_task(new_task_responce):
    return new_task_responce.json()

# ----- UTILITY -----
def delete_task_if_created(response, constants):
    if response.status_code == 201:
        task = response.json()
        task_id = task.get("id")
        if task_id:
            requests.delete(f"{constants['root_url']}/tasks/{task_id}")

# ----- GET -----

def test_hello_world(constants):
    response = requests.get(f"{constants['root_url']}/tasks/hello")
    assert response.status_code == 200
    assert all(word in response.text.lower() for word in ["hello", "world"])

def test_get_tasks(constants):
    response = requests.get(f"{constants['root_url']}/tasks")
    assert response.status_code == 200
    assert isinstance(response.json().get("tasks"), list)

def test_get_one_task(constants, first_task):
    task_id = first_task["id"]
    response = requests.get(f"{constants['root_url']}/tasks/{task_id}")
    assert response.status_code == 200
    task = response.json()
    assert task["id"] == task_id

def test_task_structure(first_task):
    assert "id" in first_task
    assert "name" in first_task
    assert "boardsNumber" in first_task
    assert "status" in first_task

def test_task_values(first_task):
    assert isinstance(first_task["id"], str)
    assert isinstance(first_task["name"], str)
    assert isinstance(first_task["boardsNumber"], int)
    assert first_task["status"] in ["CompletedOk", "CompletedFail", "InProgress"]

# incorrect usage

def test_get_nonexistent_task(constants):
    response = requests.get(f"{constants['root_url']}/tasks/imagine_if_this_is_the_actual_id")
    assert response.status_code == 404

# ----- POST -----
def test_post_task(new_task_responce):
    assert new_task_responce.status_code == 201
    new_task = new_task_responce.json()
    assert new_task.get("name") == "Test Task"
    assert new_task.get("boardsNumber") == 1

# incorrect usage

def test_post_error_tasks(constants):
    response = requests.post(f"{constants['root_url']}/tasks")
    assert response.status_code == 400

def test_post_task_with_missing_fields(constants):
    incomplete_task_body = {
        # intentionally missing "name" field
        # "name": "Incomplete Task",
    }
    response = requests.post(f"{constants['root_url']}/tasks", json=incomplete_task_body)
    delete_task_if_created(response, constants)
    assert response.status_code == 400

def test_post_task_with_incorrect_name(constants):
    incorrect_task_body = {
        "name": 123,
    }
    response = requests.post(f"{constants['root_url']}/tasks", json=incorrect_task_body)
    delete_task_if_created(response, constants)
    assert response.status_code == 400, "Created task with incorrect name type, expected failure"

def test_post_task_with_incorrect_boards_number(constants):
    incorrect_task_body = {
        "name": "Test Task",
        "boardsNumber": "not_a_number",
    }
    response = requests.post(f"{constants['root_url']}/tasks", json=incorrect_task_body)
    delete_task_if_created(response, constants)
    assert response.status_code == 400, "Created task with incorrect boardsNumber type, expected failure"

def test_post_task_with_unsupported_fields(constants):
    incorrect_task_body = {
        "name": "Test Task",
        "boardsNumber": 1,
        "imagine_if_this_is_the_actual_field_name": "some_value",
    }
    response = requests.post(f"{constants['root_url']}/tasks", json=incorrect_task_body)
    delete_task_if_created(response, constants)
    assert response.status_code == 400, "Created task with unsupported field, expected failure"

# ----- DELETE -----

def test_delete_task(constants, new_task):
    task_id = new_task["id"]
    response = requests.delete(f"{constants['root_url']}/tasks/{task_id}")
    assert response.status_code == 200
    # Verify the task is deleted
    get_response = requests.get(f"{constants['root_url']}/tasks/{task_id}")
    assert get_response.status_code == 404

# incorrect usage

def test_delete_nonexistent_task(constants):
    response = requests.delete(f"{constants['root_url']}/tasks/imagine_if_this_is_the_actual_id")
    assert response.status_code == 404

# ----- PATCH -----

# ----- PUT -----
