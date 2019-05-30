VesilD
======

*A very simple leaderboard service*

 * RESTful (ish)
 * Redis Backed
 * Really Simple!
 
API
---
This is only sort of RESTful - don't @ me!

 - PATCH /leaderboard/:leaderboardKey/member/:memberKey
 
    Increments the score for a single member in a single leaderboard
    
    If the leaderboard does not exist then it is created
    
    If the member does not exist then it is created with score equal to points
     
    ```json
    [
        {
            "path": "/points",
            "action": "increment",
            "value": (integer)
        }
     ]
    ```

    Returns a 200 response with body:
 
    ```json
    {
         "member": (string),
         "leaderboard": (string),
         "points": (integer),
         "rank": (integer)
    }
    ```
 
 - PATCH /leaderboard/:leaderboardKey
   
    As above but allowing for the incrementing of multiple member points in a single leaderboard
    
    ```json
    [
        {
             "path": "/member/:memberKey/points",
             "action": "increment",
             "value": (integer)
        },
        {
             "path": "/member/:memberKey/points",
             "action": "increment",
             "value": (integer)
        }
        ...
    ]
    ```
 
 - PATCH /member/:memberKey
 
    As above but allowing for the incrementing of multiple leaderboard points for a single member
 
    ```json
    [
       {
           "path": "/leaderboard/:leaderboardKey/points",
           "action": "increment",
           "value": (integer)
       },
       {
           "path": "/leaderboard/:leaderboardKey/points",
           "action": "increment",
           "value": (integer)
       }
       ...
    ]
    ```
 
 - GET /leaderboard/:leaderboardKey?from=x&to=y
 
    Get a list of members in a leaderboard from position x to y
  
    First position is position x
 
    If not provided the x = 1, y = 10
    
    ```json
    [
       {
          "member": (string),
          "leaderboard": (string),
          "points": (integer),
          "rank": (integer)
       },    
       {
          "member": (string),
          "leaderboard": (string),
          "points": (integer),
          "rank": (integer)
       },
       ...
    ]
    ```
 
  - GET /leaderboard/:leaderboardKey?includeMember=:id
  
    Includes the position of a member in the result set.
  
    To return just the position of this member pass ```from=0&to=0```
  
    ```json
    [
       {
          "member": (string),
          "leaderboard": (string),
          "points": (integer),
          "rank": (integer)
       },
       {
          "member": (string),
          "leaderboard": (string),
          "points": (integer),
          "rank": (integer)
       }
       ...
    ]
    ```

  - GET /member/:memberKey
  
    Gets a list of all leaderboards the member is part of
  
   ```json
    [
      {
        "member": (string),
        "leaderboard": (string),
        "points": (integer),
        "rank": (integer)
      },    
      {
        "member": (string),
        "leaderboard": (string),
        "points": (integer),
        "rank": (integer)
      },
      ...
    ]
   ```
